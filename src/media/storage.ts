import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

function resolveMediaDir(): string {
  const baseDir = process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw");
  return path.join(baseDir, "openclaw-chatclaw", "media");
}

export function saveMediaFile(base64Data: string, fileName: string, mimeType: string): string {
  const mediaDir = resolveMediaDir();
  fs.mkdirSync(mediaDir, { recursive: true });

  const hash = crypto.createHash("sha256").update(base64Data).digest("hex").slice(0, 16);
  const ext = path.extname(fileName) || getExtFromMimeType(mimeType);
  const savedFileName = `${hash}${ext}`;
  const filePath = path.join(mediaDir, savedFileName);

  if (!fs.existsSync(filePath)) {
    const buffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(filePath, buffer);
  }

  return filePath;
}

function getExtFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
  };
  return map[mimeType] || "";
}
