/** Independent field operations; no atomic multi-field transaction. */
export class PartialSetFieldsError extends Error {
  constructor(cause, operations) {
    super(`setFields failed after ${operations.length} successful SET(s): ${cause.message}`, { cause });
    this.name = 'PartialSetFieldsError';
    this.operations = operations;
  }
}

export async function setFields(store, collection, id, fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields))
    throw new TypeError('fields must be an object');
  const operations = [];
  for (const [field, value] of Object.entries(fields)) {
    try {
      const result = await store.set(collection, id, field, value);
      operations.push({ field, operationId: result.operationId });
    } catch (cause) {
      throw new PartialSetFieldsError(cause, operations);
    }
  }
  return operations;
}

/** Continue attempting remaining compensations even if one fails. */
export async function compensateFields(store, operations) {
  const results = [];
  for (const { field, operationId } of [...operations].reverse()) {
    try {
      const result = await store.compensate(operationId);
      results.push({ field, operationId, ...result });
    } catch (error) {
      results.push({ field, operationId, status: 'FAILED', error });
    }
  }
  return results;
}
