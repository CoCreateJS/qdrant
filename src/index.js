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

import { parentPort, isMainThread } from "node:worker_threads";
import database from "./database.js";
import array from "./array.js";
import object from "./object.js";

// Capture unhandled errors and rejections inside the Qdrant worker isolate thread
process.on("unhandledRejection", (reason, promise) => {
    console.error("[Qdrant Worker Isolate] Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
    console.error("[Qdrant Worker Isolate] Uncaught Exception:", err);
});

/**
 * Routes vector CRUD requests to appropriate Qdrant database, array, or object modules.
 * @param {Object} data - CRUD request payload containing method, database, array, organization_id, etc.
 * @returns {Promise<Object>} Execution result from Qdrant vector database layer
 */
async function send(data) {
    if (!data || !data.method) {
        throw new Error("Invalid request: missing method property.");
    }

    const [type, method] = data.method.split(".");
    if (type === "database") return await database(method, data);
    if (type === "array") return await array(method, data);
    if (type === "object") return await object(method, data);

    throw new Error(`Unsupported query target type: "${type}" in method "${data.method}"`);
}

/**
 * Initiates organization connection teardown for Qdrant client connections by emitting orgDeleted process event.
 * @param {string} organizationId - Target organization identifier
 */
async function closeConnection(organizationId) {
    if (organizationId) {
        process.emit("orgDeleted", organizationId);
    }
}

// Directly handle Worker Thread IPC when running inside an isolated worker thread
if (!isMainThread && parentPort) {
    parentPort.on("message", async (msg) => {
        const { id, action, data } = msg;

        // 1. Handle Worker Health Probe
        if (action === "PING") {
            parentPort.postMessage({
                id,
                status: true,
                result: "PONG"
            });
        }

        // 2. Handle Qdrant Vector CRUD Query Execution
        else if (action === "EXECUTE") {
            try {
                const result = await send(data);
                parentPort.postMessage({
                    id,
                    status: true,
                    result
                });
            } catch (err) {
                console.error("[Qdrant Worker Isolate] Error during send():", err);
                parentPort.postMessage({
                    id,
                    status: false,
                    error: err.message || err
                });
            }
        }

        // 3. Handle Organization Teardown & Connection Pool Cleanup
        else if (action === "TEARDOWN_ORG") {
            try {
                const orgId = data?.organization_id;

                if (orgId) {
                    await closeConnection(orgId);
                }

                parentPort.postMessage({
                    id,
                    status: true,
                    action: "TEARDOWN_ORG_COMPLETE",
                    organization_id: orgId
                });
            } catch (err) {
                console.error("[Qdrant Worker Isolate] Error tearing down org in worker isolate:", err);
                parentPort.postMessage({
                    id,
                    status: false,
                    error: err.message || err
                });
            }
        }

        // 4. Unknown Action Fallback
        else {
            parentPort.postMessage({
                id,
                status: false,
                error: `Unsupported Qdrant worker isolate action: "${action}"`
            });
        }
    });
}

export { send, closeConnection };
export default { send, closeConnection };