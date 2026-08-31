import {
    ObjectId,
    dotNotationToObject,
    searchData,
    isValidDate
} from "@cocreate/utils";

import { 
    dbClient, 
    createFilter, 
    createData,
    errorHandler 
} from "./utilities.js";

/**
 * "object" operations mapped to Qdrant Collection Points (Vector + Metadata Payload).
 * Documents in Qdrant must contain a "vector" key (an array of floats representing embeddings).
 */
function object(method, data) {
    const storageName = data.storageConfig?.name;
	return new Promise(async (resolve) => {
		try {
			const db = await dbClient(data);
			if (!db || db.status === false) return resolve(data);

			let type = "object";
			let documents = [];

			if (!data["timeStamp"]) {
				data["timeStamp"] = new Date().toISOString();
			}

			let databases = data.database;
			if (!Array.isArray(databases)) databases = [databases];

			for (let database of databases) {
				let arrays = data.array;
				if (!Array.isArray(arrays)) arrays = [arrays];

				for (let array of arrays) {
					const realTableName = `${data.organization_id}_${array}`;
					const reference = {
						$storage: storageName,
						$database: database,
						$array: array
					};

					if (!data[type]) data[type] = [];
					else if (typeof data[type] === "string")
						data[type] = [{ _id: data[type] }];
					else if (!Array.isArray(data[type]))
						data[type] = [data[type]];

					let isFilter = !!data.filter;
					if ((isFilter && !data[type].length) || data.isFilter) {
						data[type].splice(0, 0, { isFilter: "isEmptyObjectFilter" });
					}

					for (let i = 0; i < data[type].length; i++) {
						let $storage = data[type][i].$storage || [];
						let $database = data[type][i].$database || [];
						let $array = data[type][i].$array || [];

						if (!Array.isArray($storage)) $storage = [data[type][i].$storage];
						if (!Array.isArray($database)) $database = [data[type][i].$database];
						if (!Array.isArray($array)) $array = [data[type][i].$array];

						if (!$storage.includes(storageName)) $storage.push(storageName);
						if (!$database.includes(database)) $database.push(database);
						if (!$array.includes(array)) $array.push(array);

						delete data[type][i].$storage;
						delete data[type][i].$database;
						delete data[type][i].$array;

						let queryFilter = isFilter ? data.filter : (data[type][i].filter || null);

						if (method === "create") {
							data[type][i] = replaceArray(data[type][i]);
							data[type][i] = dotNotationToObject(data[type][i]);

							// Qdrant point IDs must be UUIDs or 64-bit integers.
							const id = data[type][i]._id || generateUUID();
							const orgId = data.organization_id;
							const created = {
								on: new Date(data.timeStamp).toISOString(),
								by: data.user_id || data.clientId
							};

							// Extract the vector data. If none is passed, we default to a mock zero-vector.
							const vector = data[type][i].vector || data[type][i].embeddings || new Array(1536).fill(0.0);
							
							const recordPayload = { ...data[type][i] };
							delete recordPayload._id;
							delete recordPayload.organization_id;
							delete recordPayload.vector;
							delete recordPayload.embeddings;

							const finalPayload = {
								_id: id,
								organization_id: orgId,
								created,
								modified: null,
								...recordPayload
							};

							process.emit("usage", {
								type: "egress",
								data: { api: "upsertPoint", collection: realTableName, id },
								organization_id: data.organization_id
							});

							await db.upsert(realTableName, {
								wait: true,
								points: [
									{
										id: id,
										vector: vector,
										payload: finalPayload
									}
								]
							});

							data[type][i] = { ...finalPayload, vector, $storage, $database, $array };
						}
						else if (method === "read") {
							if (data[type][i]._id && !isFilter) {
								process.emit("usage", {
									type: "egress",
									data: { api: "retrievePoint", collection: realTableName, id: data[type][i]._id },
									organization_id: data.organization_id
								});

								const retrieveRes = await db.retrieve(realTableName, {
									ids: [data[type][i]._id],
									with_payload: true,
									with_vector: true
								});

								if (retrieveRes.length > 0) {
									let dbRecord = retrieveRes[0].payload;
									let vector = retrieveRes[0].vector;

									if ($storage.length && data[type][i].modified && data[type][i].modified.on) {
										let clientTime = new Date(data[type][i].modified.on);
										let dbTime = new Date(dbRecord.modified ? dbRecord.modified.on : 0);

										if (clientTime > dbTime) {
											const updatedRecord = { ...dbRecord, ...data[type][i] };
											const savedRecord = await executeUpdatePoint(db, realTableName, data[type][i]._id, updatedRecord, data);
											data[type][i] = { ...savedRecord, $storage, $database, $array };
										} else {
											data[type][i] = { ...data[type][i], ...dbRecord, vector, $storage, $database, $array };
										}
									} else {
										data[type][i] = { ...data[type][i], ...dbRecord, vector, $storage, $database, $array };
									}
								} else {
									data[type].splice(i, 1);
									i--;
								}
							} else {
								process.emit("usage", {
									type: "egress",
									data: { api: "scrollPoints", collection: realTableName },
									organization_id: data.organization_id
								});

								let queryResults = [];

								if (data.filter && (data.filter.vector || data.filter.embeddings)) {
									const queryVector = data.filter.vector || data.filter.embeddings;
									const filterParams = compileFilterToQdrant(queryFilter, data.organization_id);

									process.emit("usage", {
										type: "egress",
										data: { api: "searchPoints", collection: realTableName },
										organization_id: data.organization_id
									});

									// Execute high-performance cosine similarity nearest-neighbor semantic search
									const searchRes = await db.search(realTableName, {
										vector: queryVector,
										filter: filterParams,
										limit: data.filter.limit || 10,
										with_payload: true,
										with_vector: true
									});

									for (let match of searchRes) {
										queryResults.push({
											...match.payload,
											_score: match.score,
											vector: match.vector,
											...reference
										});
									}
								} else {
									const filterParams = compileFilterToQdrant(queryFilter, data.organization_id);

									process.emit("usage", {
										type: "egress",
										data: { api: "scrollPoints", collection: realTableName },
										organization_id: data.organization_id
									});

									const scrollRes = await db.scroll(realTableName, {
										filter: filterParams,
										limit: data.filter?.limit || 100,
										offset: data.filter?.index || undefined,
										with_payload: true,
										with_vector: true
									});

									for (let pt of scrollRes.points || []) {
										queryResults.push({
											...pt.payload,
											vector: pt.vector,
											...reference
										});
									}
								}

								// In-memory sort fallback
								if (data.filter && data.filter.sort) {
									queryResults = sortData(queryResults, data.filter.sort);
								}

								for (let record of queryResults) {
									if (data.filter && data.filter.search) {
										let isMatch = searchData(record, data.filter.search);
										if (!isMatch) continue;
									}
									documents.push(record);
								}
							}
						}
						else if (method === "update") {
							const updatePayload = { ...data[type][i] };
							delete updatePayload._id;
							delete updatePayload.filter;

							if (data[type][i]._id) {
								const updatedDoc = await executeUpdatePoint(db, realTableName, data[type][i]._id, updatePayload, data);
								if (updatedDoc) {
									data[type][i] = { ...updatedDoc, $storage, $database, $array };
								}
							} else if (isFilter) {
								const filterParams = compileFilterToQdrant(queryFilter, data.organization_id);
								const scrollRes = await db.scroll(realTableName, {
									filter: filterParams,
									with_payload: true
								});

								for (let pt of scrollRes.points || []) {
									const updatedDoc = await executeUpdatePoint(db, realTableName, pt.id, updatePayload, data);
									if (updatedDoc) {
										documents.push({ ...updatedDoc, ...reference });
									}
								}
							}
						}
						else if (method === "delete") {
							if (data[type][i]._id) {
								process.emit("usage", {
									type: "egress",
									data: { api: "deletePoints", collection: realTableName, id: data[type][i]._id },
									organization_id: data.organization_id
								});
								await db.delete(realTableName, {
									points: [data[type][i]._id]
								});
								data[type][i] = { _id: data[type][i]._id, $storage, $database, $array };
							} else if (isFilter) {
								const filterParams = compileFilterToQdrant(queryFilter, data.organization_id);
								process.emit("usage", {
									type: "egress",
									data: { api: "deletePointsByFilter", collection: realTableName },
									organization_id: data.organization_id
								});

								// Get the point IDs to delete
								const scrollRes = await db.scroll(realTableName, {
									filter: filterParams,
									with_payload: false
								});

								if (scrollRes.points && scrollRes.points.length > 0) {
									const idsToDelete = scrollRes.points.map(pt => pt.id);
									await db.delete(realTableName, {
										points: idsToDelete
									});
									for (let id of idsToDelete) {
										documents.push({ _id: id, ...reference });
									}
								}
							}
						}
					}
				}
			}

			data = createData(data, documents, type);
			resolve(data);
		} catch (error) {
			errorHandler(data, error);
			console.log(method, "error", error);
			resolve(data);
		}
	});
}

export default object