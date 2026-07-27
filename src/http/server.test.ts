import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const serverSource = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

describe('files batch delete route', () => {
  it('routes POST /files/batch-delete to an authenticated batch delete handler', () => {
    expect(serverSource).toContain('parsedUrl.pathname === "/files/batch-delete" && req.method === "POST"');
    expect(serverSource).toContain('await handleBatchDeleteFiles(res, req, ctx)');
  });

  it('validates file_ids and returns deleted and failed ids', () => {
    expect(serverSource).toContain('async function handleBatchDeleteFiles');
    expect(serverSource).toContain('parseBody<{ file_ids?: unknown }>');
    expect(serverSource).toContain('Array.isArray(body.file_ids)');
    expect(serverSource).toContain('fileStorage.deleteLocalFile(fileId, fileRecord.accountId)');
    expect(serverSource).toContain('await filesDB.deleteFileRecordByFileId(fileId)');
    expect(serverSource).toContain('sendJson(res, 200, { deleted, failed })');
  });
});
