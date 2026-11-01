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
 * "database" operations. Since Qdrant is catalog-less and runs globally,
 * we emulate isolated databases by appending a prefix or treating the
 * active tenant name as a partition namespace.
 * @private
 * @environment server
 */
function database(method, data) {
    const storageName = data.storageConfig?.name;
	return new Promise(async (resolve) => {
		let type = "database";
		let databaseArray = [];

		try {
			const db = await dbClient(data);
			if (!db || db.status === false) return resolve(data);

			if (method === "read") {
				const dbName = data.database || "default";
				const dbObj = { name: dbName };

				process.emit("usage", {
					type: "egress",
					data: { api: "listDatabases", context: dbName },
					organization_id: data.organization_id
				});

				if (data.filter && data.filter.query) {
					let isFilter = queryData(dbObj, data.filter.query);
					if (isFilter) {
						databaseArray.push({ database: dbObj, storage: storageName });
					}
				} else {
					databaseArray.push({ database: dbObj, storage: storageName });
				}
				resolve(createData(data, databaseArray, type));
			}
			if (method === "delete") {
				// Emulate database partition teardown by dropping all collections with our organization prefix
				const listRes = await db.api("collections").getCollections();
				const prefix = `${data.organization_id}_`;

				for (let col of listRes.result.collections || []) {
					if (col.name.startsWith(prefix)) {
						process.emit("usage", {
							type: "egress",
							data: { api: "deleteCollection", collection: col.name },
							organization_id: data.organization_id
						});
						await db.deleteCollection(col.name);
					}
				}
				resolve({ status: true });
			}
		} catch (error) {
			errorHandler(data, error);
			console.log(method, "error", error);
			resolve(data);
		}
	});
}

export default database