import {
    ObjectId,
    dotNotationToObject,
    searchData,
    isValidDate
} from "@cocreate/utils";

import { 
    dbClient, 
    createData,
    errorHandler 
} from "./utilities.js";

/**
 * "array" operations mapped directly to Qdrant Collections.
 * We isolate multi-tenant structures cleanly by prefixing collections: "orgId_collectionName"
 */
function array(method, data) {
    const storageName = data.storageConfig?.name;
	return new Promise(async (resolve) => {
		let type = "array";
		let arrayArray = [];

		try {
			const db = await dbClient(data);
			if (!db || db.status === false) return resolve(data);

			if (data.request) data.array = data.request;

			let databases = data.database;
			if (!Array.isArray(databases)) databases = [databases];

			let databasesLength = databases.length;
			for (let database of databases) {
				const prefix = `${data.organization_id}_`;

				if (method === "read") {
					process.emit("usage", {
						type: "egress",
						data: { api: "getCollections" },
						organization_id: data.organization_id
					});

					const listRes = await db.api("collections").getCollections();
					for (let col of listRes.result.collections || []) {
						if (col.name.startsWith(prefix)) {
							const cleanName = col.name.substring(prefix.length);
							const tableObj = { name: cleanName };

							if (data.filter && data.filter.query) {
								let isFilter = queryData(tableObj, data.filter.query);
								if (isFilter) {
									arrayArray.push({ name: cleanName, database, storage: storageName });
								}
							} else {
								arrayArray.push({ name: cleanName, database, storage: storageName });
							}
						}
					}

					databasesLength -= 1;
					if (!databasesLength) {
						data = createData(data, arrayArray, type);
						resolve(data);
					}
				} else {
					let arrays = data.array;
					if (method === "update") arrays = Object.entries(data.array);
					if (!Array.isArray(arrays)) arrays = [arrays];

					let arraysLength = arrays.length;
					for (let array of arrays) {
						if (method === "create") {
							const realTableName = `${prefix}${array}`;
							
							process.emit("usage", {
								type: "egress",
								data: { api: "createCollection", collection: realTableName },
								organization_id: data.organization_id
							});

							// Create a vector index collection. Qdrant requires vector configurations.
							// Defaulting to 1536 dimensions (standard OpenAI text-embedding-3-small size) and Cosine metric.
							const vectorSize = data.vectorSize || data.vector_size || 1536;
							const distanceMetric = data.distanceMetric || data.distance_metric || "Cosine";

							await db.createCollection(realTableName, {
								vectors: {
									size: vectorSize,
									distance: distanceMetric
								}
							});

							arrayArray.push({ name: array, database, storage: storageName });

							arraysLength -= 1;
							if (!arraysLength) databasesLength -= 1;
							if (!databasesLength && !arraysLength) {
								data = createData(data, arrayArray, type);
								resolve(data);
							}
						} else {
							if (method === "update") {
								let [oldName, newName] = array;
								const oldRealName = `${prefix}${oldName}`;
								const newRealName = `${prefix}${newName}`;

								process.emit("usage", {
									type: "egress",
									data: { api: "renameCollectionEmulation", from: oldRealName, to: newRealName },
									organization_id: data.organization_id
								});

								// Qdrant does not natively support renaming collections. We emulate by creating
								// the target collection and migrating all points.
								const colInfo = await db.getCollection(oldRealName);
								const vectorParams = colInfo.config.params.vectors;

								await db.createCollection(newRealName, {
									vectors: vectorParams
								});

								// Scroll and migrate points in batches
								let scrollRes = await db.scroll(oldRealName, { limit: 100, with_payload: true, with_vector: true });
								while (scrollRes.points && scrollRes.points.length > 0) {
									await db.upsert(newRealName, {
										wait: true,
										points: scrollRes.points
									});
									if (!scrollRes.next_page_offset) break;
									scrollRes = await db.scroll(oldRealName, {
										limit: 100,
										offset: scrollRes.next_page_offset,
										with_payload: true,
										with_vector: true
									});
								}

								// Drop old collection
								await db.deleteCollection(oldRealName);

								arrayArray.push({ name: newName, oldName: oldName, database, storage: storageName });

								arraysLength -= 1;
								if (!arraysLength) databasesLength -= 1;
								if (!databasesLength && !arraysLength) {
									data = createData(data, arrayArray, type);
									resolve(data);
								}
							}

							if (method === "delete") {
								const realTableName = `${prefix}${array}`;
								process.emit("usage", {
									type: "egress",
									data: { api: "deleteCollection", collection: realTableName },
									organization_id: data.organization_id
								});

								await db.deleteCollection(realTableName);

								arrayArray.push({ name: array, database, storage: storageName });

								arraysLength -= 1;
								if (!arraysLength) databasesLength -= 1;
								if (!databasesLength && !arraysLength) {
									data = createData(data, arrayArray, type);
									resolve(data);
								}
							}
						}
					}
				}
			}
		} catch (error) {
			errorHandler(data, error);
			console.log(method, "error", error);
			resolve(data);
		}
	});
}

export default array