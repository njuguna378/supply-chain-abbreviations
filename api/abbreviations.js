import { ApiError, getWorkbookData, mutateWorkbook, parseRequestBody, publicItems, requireAdmin, validateAbbreviation, MAX_ABBREVIATIONS } from '../lib/store.js';

function sendError(res, error) {
    console.error('Abbreviation API error:', error);
    res.status(error instanceof ApiError ? error.status : 500).json({
        error: error instanceof ApiError ? error.message : 'The dictionary request failed.'
    });
}

export default async function handler(req, res) {
    try {
        if (req.method === 'GET') {
            res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
            return res.status(200).json({ items: await getWorkbookData() });
        }
        if (req.method === 'POST' || req.method === 'DELETE') {
            const user = await requireAdmin(req);
            const body = parseRequestBody(req);

            if (req.method === 'DELETE') {
                const id = String(body.id || '').trim().toUpperCase();
                if (!id) throw new ApiError(400, 'An acronym ID is required.');
                const result = await mutateWorkbook(({ items }) => {
                    const index = items.findIndex(item => item.id === id);
                    if (index < 0) throw new ApiError(404, 'That acronym was not found.');
                    items.splice(index, 1);
                    return { items: publicItems(items) };
                });
                return res.status(200).json({ ok: true, ...result });
            }

            if (body.operation === 'import') {
                if (!Array.isArray(body.items) || body.items.length > MAX_ABBREVIATIONS) {
                    throw new ApiError(400, `Import must contain no more than ${MAX_ABBREVIATIONS} rows.`);
                }
                const requestedRows = body.items.map(validateAbbreviation);
                const result = await mutateWorkbook(({ items }) => {
                    const existing = new Set(items.map(item => item.abbr.toUpperCase()));
                    let added = 0;
                    for (const item of requestedRows) {
                        if (existing.has(item.abbr)) continue;
                        existing.add(item.abbr);
                        items.push({ ...item, id: item.abbr, createdBy: user.uid });
                        added++;
                    }
                    if (items.length > MAX_ABBREVIATIONS) {
                        throw new ApiError(400, `The workbook cannot contain more than ${MAX_ABBREVIATIONS} abbreviations.`);
                    }
                    return { added, skipped: requestedRows.length - added, items: publicItems(items) };
                });
                return res.status(200).json(result);
            }

            if (body.operation !== 'create' && body.operation !== 'update') {
                throw new ApiError(400, 'Unsupported dictionary operation.');
            }
            const item = validateAbbreviation(body.item);
            const oldId = String(body.id || '').trim().toUpperCase();
            const result = await mutateWorkbook(({ items }) => {
                const index = body.operation === 'update'
                    ? items.findIndex(existing => existing.id === oldId)
                    : -1;
                if (body.operation === 'update' && index < 0) {
                    throw new ApiError(404, 'That acronym was not found.');
                }
                if (items.some((existing, itemIndex) =>
                    itemIndex !== index && existing.abbr.toUpperCase() === item.abbr
                )) {
                    throw new ApiError(409, 'That acronym already exists in the dictionary.');
                }
                const saved = { ...item, id: item.abbr, createdBy: user.uid };
                if (index >= 0) items[index] = saved;
                else items.push(saved);
                return { items: publicItems(items) };
            });
            return res.status(200).json({ ok: true, ...result });
        }

        res.setHeader('Allow', 'GET, POST, DELETE');
        return res.status(405).json({ error: 'Method not allowed.' });
    } catch (error) {
        return sendError(res, error);
    }
}
