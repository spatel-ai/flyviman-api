/** File types accepted for uploads, with the bytes each must start with. */
const SIGNATURES: Record<string, number[][]> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
};

export const ALLOWED_CONTENT_TYPES = Object.keys(SIGNATURES);

/** True when the content really is the type it was declared as. */
export function matchesDeclaredType(
  contentType: string,
  head: Uint8Array,
): boolean {
  const signatures = SIGNATURES[contentType];
  if (!signatures) return false;
  return signatures.some((signature) =>
    signature.every((byte, index) => head[index] === byte),
  );
}
