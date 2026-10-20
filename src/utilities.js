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
    const storageUrl = data.storageConfig?.url

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

		const updated = {
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
		delete savePayload.updated;
		delete savePayload.vector;
		delete savePayload.embeddings;

		const recordToWrite = {
			_id: pointId,
			organization_id: requestData.organization_id,
			created: currentRecord.created || updated,
			updated,
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

export {
    dbClient,
    createData,
    errorHandler
};