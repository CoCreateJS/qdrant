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

import database from "./database.js";
import array from "./array.js";
import object from "./object.js";

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

export default { send };