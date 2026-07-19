/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

import { QdrantClient } from "@qdrant/js-client-rest";
import {
	dotNotationToObject,
	queryData,
	searchData,
	sortData,
	isValidDate
} from "@cocreate/utils";

const organizations = {};

/**
 * Dynamically resolves or caches a long-lived Qdrant Vector Client connection.
 * Caches the connection promise to prevent concurrent, duplicate handshakes.
 * Supports direct connection URLs as well as credential objects containing API keys.
 */
async function dbClient(data) {
	const storageUrl = data.storageUrl || data.url;

	if (storageUrl) {
		if (!organizations[data.organization_id]) {
			organizations[data.organization_id] = {};
		}
		try {
			if (!organizations[data.organization_id][storageUrl]) {
				const connectionPromise = (async () => {
					let config = {};

					// Case A: Structured credentials object containing apiKey and endpoint
					if (typeof storageUrl === "object" && storageUrl !== null) {
						config = {
							url: storageUrl.url || storageUrl.endpoint || "http://localhost:6333",
							apiKey: storageUrl.apiKey || storageUrl.api_key || undefined
						};
					} 
					// Case B: Standard connection string URL
					else if (typeof storageUrl === "string") {
						config = { url: storageUrl };
					}

					const client = new QdrantClient(config);
					
					// Test the client connection viability
					await client.api("collections").getCollections();
					return client;
				})();

				organizations[data.organization_id][storageUrl] = connectionPromise;
			}

			return await organizations[data.organization_id][storageUrl];
		} catch (error) {
			console.error(`${data.organization_id}: Qdrant failed to connect`);
			errorHandler(data, error);
			return { status: false };
		}
	}

	errorHandler(data, "missing Qdrant Connection URL/Credentials");
	return;
}

/**
 * Global Event Listener: orgDeleted
 * Cleans up active Qdrant instances and destroys connection configurations gracefully.
 */
process.on("orgDeleted", (organization_id) => {
	const orgPools = organizations[organization_id];
	if (orgPools) {
		console.log(`[Qdrant Utilities] Cleanup Scheduled: Initiating 5-second grace period for Org: ${organization_id}`);
		setTimeout(async () => {
			const currentPools = organizations[organization_id];
			if (!currentPools) return;

			console.log(`[Qdrant Utilities] Cleanup Executing: Closing clients for Org: ${organization_id}`);
			// Qdrant client uses standard http/https fetch underneath, so we simply delete the cached connections
			delete organizations[organization_id];
			console.log(`[Qdrant Utilities] Memory Cleared: Registry freed for Org: ${organization_id}`);
		}, 5000);
	}
});

/**
 * Universal router matching the standard CoCreate pipeline signature.
 */
export function send(data) {
	let [type, method] = data.method.split(".");
	if (type === "database") return database(method, data);
	if (type === "array") return array(method, data);
	if (type === "object") return object(method, data);
}

/**
 * "database" operations. Since Qdrant is catalog-less and runs globally,
 * we emulate isolated databases by appending a prefix or treating the 
 * active tenant name as a partition namespace.
 */
function database(method, data) {
	const storageName = data.storageName || data.provider || "qdrant";
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

				if (data.$filter && data.$filter.query) {
					let isFilter = queryData(dbObj, data.$filter.query);
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

/**
 * "array" operations mapped directly to Qdrant Collections.
 * We isolate multi-tenant structures cleanly by prefixing collections: "orgId_collectionName"
 */
function array(method, data) {
	const storageName = data.storageName || data.provider || "qdrant";
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

							if (data.$filter && data.$filter.query) {
								let isFilter = queryData(tableObj, data.$filter.query);
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

/**
 * "object" operations mapped to Qdrant Collection Points (Vector + Metadata Payload).
 * Documents in Qdrant must contain a "vector" key (an array of floats representing embeddings).
 */
function object(method, data) {
	const storageName = data.storageName || data.provider || "qdrant";
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

					let isFilter = !!data.$filter;
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

						let queryFilter = isFilter ? data.$filter : (data[type][i].$filter || null);

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

								if (data.$filter && (data.$filter.vector || data.$filter.embeddings)) {
									const queryVector = data.$filter.vector || data.$filter.embeddings;
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
										limit: data.$filter.limit || 10,
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
										limit: data.$filter?.limit || 100,
										offset: data.$filter?.index || undefined,
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
								if (data.$filter && data.$filter.sort) {
									queryResults = sortData(queryResults, data.$filter.sort);
								}

								for (let record of queryResults) {
									if (data.$filter && data.$filter.search) {
										let isMatch = searchData(record, data.$filter.search);
										if (!isMatch) continue;
									}
									documents.push(record);
								}
							}
						}
						else if (method === "update") {
							const updatePayload = { ...data[type][i] };
							delete updatePayload._id;
							delete updatePayload.$filter;

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

/**
 * Simulates transactional updates inside Qdrant by performing a Retrieve-Modify-Upsert lock pattern.
 */
async function executeUpdatePoint(db, realTableName, pointId, rawUpdateInput, requestData) {
	try {
		const retrieveRes = await db.retrieve(realTableName, {
			ids: [pointId],
			with_payload: true,
			with_vector: true
		});

		let currentPoint = retrieveRes.length > 0 ? retrieveRes[0] : null;
		let currentRecord = currentPoint ? currentPoint.payload : null;
		let currentVector = currentPoint ? currentPoint.vector : (rawUpdateInput.vector || rawUpdateInput.embeddings || new Array(1536).fill(0.0));

		if (!currentRecord) {
			if (requestData.upsert || rawUpdateInput.upsert || rawUpdateInput.$upsert) {
				currentRecord = { _id: pointId, organization_id: requestData.organization_id };
			} else {
				return null;
			}
		}

		const modified = {
			on: new Date(requestData.timeStamp).toISOString(),
			by: requestData.user_id || requestData.clientId
		};

		// Run deep nested JSON modifier aligning with Mongo semantics
		const updatedPayload = applyMongoUpdate(currentRecord, rawUpdateInput);

		// If a new vector was passed in the update payload, update the vectors coordinates
		if (rawUpdateInput.vector || rawUpdateInput.embeddings) {
			currentVector = rawUpdateInput.vector || rawUpdateInput.embeddings;
		}

		const savePayload = { ...updatedPayload };
		delete savePayload._id;
		delete savePayload.organization_id;
		delete savePayload.created;
		delete savePayload.modified;
		delete savePayload.vector;
		delete savePayload.embeddings;

		const recordToWrite = {
			_id: pointId,
			organization_id: requestData.organization_id,
			created: currentRecord.created || modified,
			modified,
			...savePayload
		};

		process.emit("usage", {
			type: "egress",
			data: { api: "upsertPoint", collection: realTableName, id: pointId },
			organization_id: requestData.organization_id
		});

		await db.upsert(realTableName, {
			wait: true,
			points: [
				{
					id: pointId,
					vector: currentVector,
					payload: recordToWrite
				}
			]
		});

		return { ...recordToWrite, vector: currentVector };
	} catch (error) {
		throw error;
	}
}

/**
 * Applies MongoDB update operators recursively on payloads before index storage.
 */
function applyMongoUpdate(record, updatePayload) {
	let target = { ...record };

	Object.keys(updatePayload).forEach((rawKey) => {
		if (rawKey.startsWith("$")) return;
		let cleanKey = rawKey.replace(/\[(\d+)\]/g, ".$1");
		setNestedValue(target, cleanKey, updatePayload[rawKey]);
	});

	if (updatePayload.$set) {
		Object.keys(updatePayload.$set).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			setNestedValue(target, cleanKey, updatePayload.$set[key]);
		});
	}

	if (updatePayload.$unset) {
		Object.keys(updatePayload.$unset).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			deleteNestedValue(target, cleanKey);
		});
	}

	if (updatePayload.$inc) {
		Object.keys(updatePayload.$inc).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let currentVal = getNestedValue(target, cleanKey) || 0;
			setNestedValue(target, cleanKey, Number(currentVal) + Number(updatePayload.$inc[key]));
		});
	}

	if (updatePayload.$push) {
		Object.keys(updatePayload.$push).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (!Array.isArray(arr)) arr = [];

			const pushValue = updatePayload.$push[key];
			if (pushValue && pushValue.$each) {
				let valuesToPush = pushValue.$each;
				let position = typeof pushValue.$position === "number" ? pushValue.$position : arr.length;
				arr.splice(position, 0, ...valuesToPush);
			} else {
				arr.push(pushValue);
			}
			setNestedValue(target, cleanKey, arr);
		});
	}

	if (updatePayload.$pull) {
		Object.keys(updatePayload.$pull).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (Array.isArray(arr)) {
				const filterVal = updatePayload.$pull[key];
				arr = arr.filter(item => {
					if (typeof filterVal === "object" && filterVal !== null) {
						return !queryData(item, filterVal);
					}
					return item !== filterVal;
				});
				setNestedValue(target, cleanKey, arr);
			}
		});
	}

	if (updatePayload.$addToSet) {
		Object.keys(updatePayload.$addToSet).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (!Array.isArray(arr)) arr = [];

			const addValue = updatePayload.$addToSet[key];
			if (addValue && addValue.$each) {
				addValue.$each.forEach(item => {
					if (!arr.includes(item)) arr.push(item);
				});
			} else {
				if (!arr.includes(addValue)) arr.push(addValue);
			}
			setNestedValue(target, cleanKey, arr);
		});
	}

	return target;
}

/**
 * Normalizes and translates Mongo-style schema filters dynamically to Qdrant Payload Filter syntax.
 */
function compileFilterToQdrant(filter, organizationId) {
	let qdrantFilter = {
		must: [
			{
				key: "organization_id",
				match: { value: organizationId }
			}
		]
	};

	if (filter && filter.query) {
		for (let key in filter.query) {
			if (["$or", "$and", "organization_id"].includes(key)) continue;

			let value = filter.query[key];

			if (value && typeof value === "object" && !Array.isArray(value)) {
				for (let op in value) {
					let operand = value[op];
					if (op === "$gt") qdrantFilter.must.push({ key, range: { gt: operand } });
					else if (op === "$gte") qdrantFilter.must.push({ key, range: { gte: operand } });
					else if (op === "$lt") qdrantFilter.must.push({ key, range: { lt: operand } });
					else if (op === "$lte") qdrantFilter.must.push({ key, range: { lte: operand } });
					else if (op === "$ne") {
						if (!qdrantFilter.must_not) qdrantFilter.must_not = [];
						qdrantFilter.must_not.push({ key, match: { value: operand } });
					}
					else if (op === "$in") {
						qdrantFilter.must.push({ key, match: { any: operand } });
					}
				}
			} else {
				qdrantFilter.must.push({
					key: key,
					match: { value: value }
				});
			}
		}
	}

	return qdrantFilter;
}

/**
 * UUID generator utility used to produce fully compliant UUID-v4 point IDs for Qdrant.
 */
function generateUUID() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
		const r = (Math.random() * 16) | 0,
			v = c == "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function replaceArray(data = {}) {
	let object = {};
	Object.keys(data).forEach((key) => {
		object[key.replace(/\[(\d+)\]/g, ".$1")] = data[key];
	});
	return object;
}

function getNestedValue(obj, path) {
	return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

function setNestedValue(obj, path, value) {
	const parts = path.split(".");
	const last = parts.pop();
	const target = parts.reduce((acc, part) => acc[part] = acc[part] || {}, obj);
	target[last] = value;
}

function deleteNestedValue(obj, path) {
	const parts = path.split(".");
	const last = parts.pop();
	const target = parts.reduce((acc, part) => acc && acc[part], obj);
	if (target) delete target[last];
}

function createData(data, array, type) {
	if (data[type] && data[type][0] && data[type][0].isFilter === "isEmptyObjectFilter") {
		data[type].shift();
		data.isFilter = true;
	}

	let key = type !== "object" ? "name" : "_id";

	if (!Array.isArray(data[type])) {
		console.log("data[type] is not an array", type);
	} else {
		for (let i = 0; i < array.length; i++) {
			const matchIndex = data[type].findIndex((item) => item[key] === array[i][key]);
			if (matchIndex !== -1) {
				for (let $type of ["$storage", "$database", "$array"]) {
					if (!data[type][matchIndex][$type])
						data[type][matchIndex][$type] = [];
					if (!Array.isArray(data[type][matchIndex][$type])) {
						data[type][matchIndex][$type] = [data[type][matchIndex][$type]];
					}
					if (!data[type][matchIndex][$type].includes(array[i][$type])) {
						data[type][matchIndex][$type].push(array[i][$type]);
					}
					delete array[i][$type];
				}
				data[type][matchIndex] = { ...data[type][matchIndex], ...array[i] };
			} else {
				data[type].push(array[i]);
			}
		}
	}
	return data;
}

function errorHandler(data, error, database, array) {
	let errorMessage = typeof error === "object" && error.message ? error.message : error;
	let errorObject = {
		message: errorMessage,
		storage: "qdrant"
	};

	if (database) errorObject.database = database;
	if (array) errorObject.array = array;

	if (Array.isArray(data.error)) {
		data.error.push(errorObject);
	} else {
		data.error = [errorObject];
	}
}

export default { send };