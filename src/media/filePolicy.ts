export function shouldSkipFilesDbRecord(params: {
  contentType?: string;
  fileName?: string;
  fileUrl?: string;
  mimeType?: string;
}): boolean {
  return params.contentType === "voice";
}

export function shouldDeleteLocalFileOnMessageRemoval(params: {
  direction: "inbound" | "outbound";
  contentType?: string;
  fileName?: string;
  fileUrl?: string;
}): boolean {
  if (!params.fileUrl?.startsWith("/files/download/")) {
    return false;
  }

  if (params.direction === "inbound") {
    return true;
  }

  return params.contentType === "voice";
}
