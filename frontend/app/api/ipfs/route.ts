import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

// Filebase = S3-compatible API + auto-pinning to IPFS. Ported from the
// Unicurve launchpad. Each PUT returns an IPFS CID, giving us both an HTTPS
// gateway URL and an `ipfs://CID` URI (the latter is what we bake into the
// PerpToken's immutable `tokenUri`).
//
// Required env (SERVER-SIDE only — never NEXT_PUBLIC_*):
//   FILEBASE_KEY     access key
//   FILEBASE_SECRET  secret key
//   FILEBASE_BUCKET  bucket name (we reuse the shared `unicurve` bucket)
//
// Metadata JSON shape MUST match perpfactory-indexer/src/index.ts fetchMetadata:
//   { name, symbol, description, image: ipfs://…, twitter, telegram, website }

const KEY    = process.env.FILEBASE_KEY;
const SECRET = process.env.FILEBASE_SECRET;
const BUCKET = process.env.FILEBASE_BUCKET;

const client = KEY && SECRET
  ? new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.filebase.com",
      credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
    })
  : null;

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB

export async function POST(req: NextRequest) {
  if (!client || !BUCKET) return userError("config", 500);

  const formRaw = await req.formData().catch(() => null);
  if (!formRaw) {
    return NextResponse.json({ error: "Could not read your upload. Please try again." }, { status: 400 });
  }
  // Reconcile undici (req.formData) vs DOM FormData typings — runtime has .get().
  const formData = formRaw as unknown as FormData;

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Please select an image to upload." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image is too large. Please use one under 4 MB." }, { status: 413 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Only image files are supported." }, { status: 415 });
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
    const sha = createHash("sha256").update(buf).digest("hex").slice(0, 32);
    const imageKey = `perpfactory/images/${sha}.${ext}`;

    // 1. upload image → resolve its IPFS CID
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: imageKey, Body: buf, ContentType: file.type,
    }));
    const imageCid = await resolveCid(client, BUCKET, imageKey);
    if (!imageCid) {
      console.error("[ipfs] no CID for image", { imageKey });
      return userError("upload", 502);
    }

    // 2. build + upload metadata JSON (fields match the indexer's parser)
    const name        = (formData.get("name")        as string | null) ?? "";
    const symbol      = (formData.get("symbol")      as string | null) ?? "";
    const description = (formData.get("description") as string | null) ?? "";
    const twitter     = (formData.get("twitter")     as string | null) ?? "";
    const telegram    = (formData.get("telegram")    as string | null) ?? "";
    const website     = (formData.get("website")     as string | null) ?? "";

    const metadata = {
      name,
      symbol,
      description: description || null,
      image: `ipfs://${imageCid}`,
      twitter:  twitter  || null,
      telegram: telegram || null,
      website:  website  || null,
    };
    const metaBody = Buffer.from(JSON.stringify(metadata));
    const metaKey  = `perpfactory/metadata/${sha}.json`;
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: metaKey, Body: metaBody, ContentType: "application/json",
    }));
    const metaCid = await resolveCid(client, BUCKET, metaKey);
    if (!metaCid) {
      console.error("[ipfs] no CID for metadata", { metaKey });
      return userError("upload", 502);
    }

    return NextResponse.json({
      imageCid,
      imageURI: `ipfs://${imageCid}`,
      metadataCid: metaCid,
      metadataURI: `ipfs://${metaCid}`,
      gatewayImage: `https://${BUCKET}.s3.filebase.com/${imageKey}`,
    });
  } catch (err: any) {
    console.error("[ipfs] upload failed:", err);
    return userError("upload", 502);
  }
}

function userError(kind: "upload" | "config", status: number) {
  const message = kind === "config"
    ? "Image storage is not configured. Please contact support."
    : "Image upload failed. Please try again.";
  return NextResponse.json({ error: message }, { status });
}

/// Resolve an object's IPFS CID from Filebase. HeadObject always answers with
/// the CID in either Metadata.cid or the x-amz-meta-cid response header.
async function resolveCid(c: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const head = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const md = head.Metadata ?? {};
    if (md.cid) return md.cid;
    const headers = (head as any).$metadata?.httpHeaders ?? {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "x-amz-meta-cid" && v) return v as string;
    }
    return null;
  } catch (err) {
    console.error("[ipfs] HeadObject failed for", key, err);
    return null;
  }
}
