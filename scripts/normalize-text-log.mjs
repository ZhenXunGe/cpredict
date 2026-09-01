#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function normalizeTextLog(text) {
  const normalizedLines = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/gu, ""));

  while (normalizedLines.at(-1) === "") {
    normalizedLines.pop();
  }

  return normalizedLines.length === 0 ? "" : `${normalizedLines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const [inputPath, outputPath = inputPath] = argv;
  if (!inputPath || argv.length > 2) {
    throw new Error("usage: normalize-text-log.mjs <input> [output]");
  }

  const input = await readFile(inputPath, "utf8");
  await writeFile(outputPath, normalizeTextLog(input), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
