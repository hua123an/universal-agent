import path from 'node:path';

export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

export function resolveWorkspacePath(root: string, candidate: string): string {
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);

  if (!isPathInside(root, absolute)) {
    throw new Error(
      `Path is outside the workspace root and was rejected: ${candidate}`
    );
  }

  return absolute;
}

export function toDisplayPath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative || '.';
}
