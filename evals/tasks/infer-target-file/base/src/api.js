// Top-level handler that builds an API response from a user record.
// Composes formatUser -> serializeResponse. The whitespace bug isn't here.
import { formatUser } from './format.js';
import { serializeResponse } from './serialize.js';

export const handleGetUser = (record) => serializeResponse(formatUser(record));
