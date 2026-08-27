import { constants, copyFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** Copies an image without replacing an existing file in the destination directory. */
export function saveImage(source: string, destinationDir: string): string {
  const filename = basename(source);
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);

  for (let suffix = 0; ; suffix += 1) {
    const destination = join(destinationDir, suffix === 0 ? filename : `${stem}-${suffix}${extension}`);
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
