#!/usr/bin/env node

import { resolve } from "node:path";

import { hashInputInventory } from "./write-gate-evidence.mjs";

function parseArguments(arguments_) {
  const options = { root: process.cwd(), inputs: [] };
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--root") options.root = value;
    else if (flag === "--input") options.inputs.push(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const snapshot = await hashInputInventory(resolve(options.root), options.inputs);
process.stdout.write(`${snapshot}\n`);
