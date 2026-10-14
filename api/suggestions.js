import { randomUUID } from 'node:crypto';
import { ApiError, getPendingSuggestions, mutateWorkbook, parseRequestBody, publicItems, requireAdmin, validateAbbreviation, MAX_SUGGESTIONS } from '../lib/store.js';

function sendError(res, error) {
    console.error('Suggestion API error:', error);
    res.status(error instanceof ApiError ? error.status : 500).json({
        error: error instanceof ApiError ? error.message : 'The suggestion request failed.'
    });
}

export default async function handler(req, res) {
    try {
        if (req.method === 'GET') {
            await requireAdmin(req);
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ items: await getPendingSuggestions() });
        }

        if (req.method === 'POST') {
            const body = parseRequestBody(req);
            const suggestion = validateAbbreviation(body);
            const result = await mutateWorkbook(({ items, suggestions }) => {
                const duplicateSuggestion = suggestions.some(item =>
                    item.status === 'pending' && item.abbr.toUpperCase() === suggestion.abbr
                );
                const existingAcronym = items.some(item =>
                    item.abbr.toUpperCase() === suggestion.abbr
                );
                if (existingAcronym) throw new ApiError(409, 'That acronym is already in the dictionary.');
                if (duplicateSuggestion) throw new ApiError(409, 'That acronym already has a pending suggestion.');
                if (suggestions.length >= MAX_SUGGESTIONS) {
                    throw new ApiError(503, 'The suggestion queue is full. Please try again later.');
                }
                const item = {
                    id: randomUUID(),
                    ...suggestion,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                };
                suggestions.push(item);
                return item.id;
            });
            return res.status(201).json({ ok: true, id: result });
        }

        if (req.method === 'PATCH') {
            const user = await requireAdmin(req);
            const body = parseRequestBody(req);
            const id = String(body.id || '').trim();
            if (!id || !['approve', 'reject'].includes(body.action)) {
                throw new ApiError(400, 'A suggestion ID and valid review action are required.');
            }
            const result = await mutateWorkbook(({ items, suggestions }) => {
                const suggestion = suggestions.find(item => item.id === id && item.status === 'pending');
                if (!suggestion) throw new ApiError(404, 'That pending suggestion was not found.');
                if (body.action === 'approve') {
                    if (items.some(item => item.abbr.toUpperCase() === suggestion.abbr.toUpperCase())) {
                        throw new ApiError(409, 'That acronym already exists in the dictionary.');
                    }
                    items.push({
                        id: suggestion.abbr.toUpperCase(),
                        abbr: suggestion.abbr.toUpperCase(),
                        definition: suggestion.definition,
                        meaning: '',
                        createdBy: user.uid
                    });
                }
                suggestion.status = body.action === 'approve' ? 'approved' : 'rejected';
                suggestion.reviewedAt = new Date().toISOString();
                suggestion.reviewedBy = user.uid;
                return { items: publicItems(items) };
            });
            return res.status(200).json({ ok: true, ...result });
        }

        res.setHeader('Allow', 'GET, POST, PATCH');
        return res.status(405).json({ error: 'Method not allowed.' });
    } catch (error) {
        return sendError(res, error);
    }
}
