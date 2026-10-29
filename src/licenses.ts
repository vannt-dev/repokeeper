import { readTemplate } from "./templates.js";

/** SPDX ids of the licenses repokeeper can write as LICENSE, in the order the docs list them. */
export const LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "MPL-2.0",
  "Unlicense",
] as const;

export type LicenseId = (typeof LICENSES)[number];

export function isLicense(id: string): id is LicenseId {
  return (LICENSES as readonly string[]).includes(id);
}

// written inline since the first release; kept so that MIT repositories see no change
const MIT = (holder: string) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * The bundled text (choosealicense.com, which GitHub writes from) and the holder placeholder it carries.
 * The GPL ids differ only in the notice each file carries; the LICENSE text is the same.
 */
const BUNDLED: Record<Exclude<LicenseId, "MIT">, { file: string; holder?: string }> = {
  "Apache-2.0": { file: "Apache-2.0.txt" },
  "BSD-3-Clause": { file: "BSD-3-Clause.txt", holder: "[year], [fullname]" },
  "GPL-3.0-only": { file: "GPL-3.0.txt" },
  "GPL-3.0-or-later": { file: "GPL-3.0.txt" },
  ISC: { file: "ISC.txt", holder: "[year] [fullname]" },
  "MPL-2.0": { file: "MPL-2.0.txt" },
  Unlicense: { file: "Unlicense.txt" },
};

/** The LICENSE file for an SPDX id, with the copyright line (`2026 Van Nguyen`) filled in where it has one. */
export function licenseText(id: LicenseId, holder: string): string {
  if (id === "MIT") return MIT(holder);
  const { file, holder: placeholder } = BUNDLED[id];
  const text = readTemplate(`licenses/${file}`);
  return placeholder ? text.replace(placeholder, () => holder) : text;
}
