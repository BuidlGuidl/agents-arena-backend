import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { getAddress, isAddress, type Address } from 'viem';

export const CHALLENGE_COUNT = 12;

export interface ChallengePackOptions {
  aiCtfRepo: string;
  outDir: string;
  deploymentsNetwork?: string;
}

export interface ChallengePack {
  dir: string;
  addresses: Readonly<Record<string, Address>>;
  titles: Readonly<Record<number, string>>;
}

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function contains(parent: string, child: string): boolean {
  const step = relative(parent, child);
  return step !== '' && !step.startsWith('..') && !isAbsolute(step);
}

// assembleChallengePack replaces outDir wholesale, so a caller that points it at
// the ai-ctf checkout would delete the source it is copying from.
function assertSafeOutDir(aiCtfRepo: string, outDir: string): void {
  if (outDir === '') {
    throw new Error('Challenge pack outDir must not be empty');
  }
  if (outDir === aiCtfRepo || contains(aiCtfRepo, outDir) || contains(outDir, aiCtfRepo)) {
    throw new Error(
      `Challenge pack outDir ${outDir} overlaps the ai-ctf checkout ${aiCtfRepo}; pick a directory outside it`,
    );
  }
}

function assertSafeNetwork(network: string): void {
  if (network === '' || network.includes('..') || network.includes(sep) || network.includes('/')) {
    throw new Error(`Invalid deployments network: ${network}`);
  }
}

function deploymentAddress(path: string): Address {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`Invalid deployment JSON: ${path}`);
  }

  if (
    typeof value !== 'object'
    || value === null
    || !('address' in value)
    || typeof value.address !== 'string'
    || !isAddress(value.address)
  ) {
    throw new Error(`Invalid deployment address: ${path}`);
  }

  return getAddress(value.address);
}

function loadAddresses(deploymentsDir: string): Readonly<Record<string, Address>> {
  requireDirectory(deploymentsDir, 'Deployments directory');
  const deploymentFiles = readdirSync(deploymentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(deploymentsDir, entry.name))
    .sort();

  if (deploymentFiles.length === 0) {
    throw new Error(`No deployment JSON files found: ${deploymentsDir}`);
  }

  // Null-prototype so a deployment named __proto__.json cannot silently vanish.
  const addresses = Object.create(null) as Record<string, Address>;
  for (const path of deploymentFiles) {
    addresses[basename(path, '.json')] = deploymentAddress(path);
  }

  // BRIEFING.md tells the entrant these addresses are authoritative, so a partial
  // deployment set has to fail rather than ship a briefing with holes.
  const required = [
    ...Array.from({ length: CHALLENGE_COUNT }, (_, index) => `Challenge${index + 1}`),
    'NFTFlags',
  ];
  const missing = required.filter((name) => addresses[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Deployments are missing ${missing.join(', ')}: ${deploymentsDir}`);
  }

  return Object.freeze(addresses);
}

function contractOrder([nameA]: [string, Address], [nameB]: [string, Address]): number {
  const challengeA = /^Challenge([1-9]|1[0-2])$/.exec(nameA);
  const challengeB = /^Challenge([1-9]|1[0-2])$/.exec(nameB);

  if (challengeA && challengeB) {
    return Number(challengeA[1]) - Number(challengeB[1]);
  }
  if (challengeA) {
    return -1;
  }
  if (challengeB) {
    return 1;
  }
  // Not localeCompare: collation varies with ICU data, and this ordering ends up
  // in a file two systems compare.
  if (nameA < nameB) return -1;
  return nameA > nameB ? 1 : 0;
}

interface ChallengeMaterial {
  contents: readonly string[];
  titles: Readonly<Record<number, string>>;
}

export function loadChallengeMaterial(aiCtfRepo: string): ChallengeMaterial {
  const resolvedRepo = resolve(aiCtfRepo);
  const challengeDir = join(resolvedRepo, 'packages', 'nextjs', 'data', 'challenges');
  const contents: string[] = [];
  const titles = Object.create(null) as Record<number, string>;
  for (let number = 1; number <= CHALLENGE_COUNT; number += 1) {
    const challengePath = join(challengeDir, `${number}.md`);
    requireFile(challengePath, 'Challenge markdown');
    const content = readFileSync(challengePath, 'utf8');
    const heading = new RegExp(`^# #${number}:\\s*(.+?)\\s*$`, 'm').exec(content);
    titles[number] = heading?.[1]?.trim() || `Challenge ${number}`;
    contents.push(content.endsWith('\n') ? content : `${content}\n`);
  }
  return { contents, titles: Object.freeze(titles) };
}

// Challenge 9's hint links the deploy script on github, but the repo is not readable
// from an entrant container and the pack ships that exact file. Entrants followed the
// link, got a 404, and hand-decompiled the bytecode instead (ai.ctf#46).
const CHALLENGE_9_DEPLOY_LINK =
  'https://github.com/buidlguidl/ai.ctf.buidlguidl.com/blob/main/packages/hardhat/deploy/00_deploy_ctf_contracts.ts';
const PACKED_DEPLOY_SCRIPT = 'deploy/00_deploy_ctf_contracts.ts';

export function localizePackLinks(markdown: string): string {
  return markdown.replaceAll(CHALLENGE_9_DEPLOY_LINK, PACKED_DEPLOY_SCRIPT);
}

function buildBriefing(
  addresses: Readonly<Record<string, Address>>,
  challengeContents: readonly string[],
): string {

  const tableRows = Object.entries(addresses)
    .sort(contractOrder)
    .map(([name, address]) => `| ${name} | ${address} |`);
  const intro = [
    'The addresses in the table below were deployed on the chain this run uses and are authoritative for this run.',
    'The Solidity source is in contracts/.',
    'The deploy script is in deploy/.',
  ].join(' ');

  return [
    '# Solidity Invaders — the BuidlGuidl Fortress briefing',
    '',
    intro,
    '',
    '## Contract addresses',
    '',
    '| Contract | Address |',
    '| --- | --- |',
    ...tableRows,
    '',
    '## Challenges',
    '',
    challengeContents.map((content) => `---\n\n${localizePackLinks(content)}`).join('\n'),
  ].join('\n');
}

export function assembleChallengePack(options: ChallengePackOptions): ChallengePack {
  const deploymentsNetwork = options.deploymentsNetwork ?? 'localhost';
  assertSafeNetwork(deploymentsNetwork);

  const aiCtfRepo = resolve(options.aiCtfRepo);
  const outDir = options.outDir === '' ? '' : resolve(options.outDir);
  assertSafeOutDir(aiCtfRepo, outDir);

  const hardhatDir = join(aiCtfRepo, 'packages', 'hardhat');
  const deploymentsDir = join(hardhatDir, 'deployments', deploymentsNetwork);
  const contractsDir = join(hardhatDir, 'contracts');
  const deployPath = join(hardhatDir, 'deploy', '00_deploy_ctf_contracts.ts');
  const addresses = loadAddresses(deploymentsDir);

  requireDirectory(contractsDir, 'Contracts directory');
  const contractFiles = readdirSync(contractsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sol'))
    .map((entry) => entry.name)
    .sort();
  if (contractFiles.length === 0) {
    throw new Error(`No Solidity files found: ${contractsDir}`);
  }
  requireFile(deployPath, 'Deploy script');
  const material = loadChallengeMaterial(aiCtfRepo);
  const briefing = buildBriefing(addresses, material.contents);

  // Staged then renamed so a build that fails partway leaves the previous pack
  // in place, rather than a half-copied directory that still looks complete.
  const staging = `${outDir}.incoming-${randomUUID().slice(0, 8)}`;
  try {
    const stagedContracts = join(staging, 'contracts');
    const stagedDeploy = join(staging, 'deploy');
    mkdirSync(stagedContracts, { recursive: true });
    mkdirSync(stagedDeploy, { recursive: true });

    for (const contractFile of contractFiles) {
      copyFileSync(join(contractsDir, contractFile), join(stagedContracts, contractFile));
    }
    copyFileSync(deployPath, join(stagedDeploy, '00_deploy_ctf_contracts.ts'));
    writeFileSync(join(staging, 'BRIEFING.md'), briefing);

    rmSync(outDir, { recursive: true, force: true });
    renameSync(staging, outDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    dir: outDir,
    addresses,
    titles: material.titles,
  };
}
