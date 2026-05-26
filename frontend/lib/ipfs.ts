// IPFS uploads via our server-side Filebase route (app/api/ipfs/route.ts).
// The Filebase secret stays server-side; the browser only POSTs the form to
// the same-origin `/api/ipfs`. One round-trip pins both the image and the
// metadata JSON and returns their ipfs:// URIs.

export class IpfsError extends Error {
  constructor(message: string, public detail?: unknown) {
    super(message);
    this.name = "IpfsError";
  }
}

export interface LaunchMeta {
  file: File;
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface UploadResult {
  imageURI: `ipfs://${string}`;
  metadataURI: `ipfs://${string}`;
  gatewayImage?: string;
}

// IPFS is always available now (server-route + server-held creds). Kept as a
// function so call sites that gated on Pinata config keep compiling.
export function ipfsConfigured(): boolean { return true; }

/// Upload the logo + build/pin the metadata JSON in one server round-trip.
/// The returned `metadataURI` is what gets baked into the PerpToken's
/// immutable `tokenUri` (and fed into the CREATE2 token-salt mining).
export async function uploadLaunchMetadata(m: LaunchMeta): Promise<UploadResult> {
  const fd = new FormData();
  fd.append("file", m.file, m.file.name);
  fd.append("name", m.name);
  fd.append("symbol", m.symbol);
  if (m.description) fd.append("description", m.description);
  if (m.twitter)     fd.append("twitter", m.twitter);
  if (m.telegram)    fd.append("telegram", m.telegram);
  if (m.website)     fd.append("website", m.website);

  let res: Response;
  try {
    res = await fetch("/api/ipfs", { method: "POST", body: fd });
  } catch (e) {
    throw new IpfsError("Could not reach the upload service. Please try again.", e);
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new IpfsError((j as any)?.error ?? `Upload failed: ${res.status}`);
  }
  const j = (await res.json()) as Partial<UploadResult>;
  if (!j.imageURI || !j.metadataURI) {
    throw new IpfsError("Upload service returned an incomplete result.", j);
  }
  return { imageURI: j.imageURI, metadataURI: j.metadataURI, gatewayImage: j.gatewayImage };
}
