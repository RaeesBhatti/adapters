import type { AstroConfig, AstroIntegrationLogger, IntegrationRouteData, RoutePart } from 'astro';

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	prependForwardSlash,
	removeLeadingForwardSlash,
	removeTrailingForwardSlash,
} from '@astrojs/internal-helpers/path';
import glob from 'tiny-glob';

// Copied from https://github.com/withastro/astro/blob/3776ecf0aa9e08a992d3ae76e90682fd04093721/packages/astro/src/core/routing/manifest/create.ts#L45-L70
// We're not sure how to improve this regex yet
// eslint-disable-next-line regexp/no-super-linear-backtracking
const ROUTE_DYNAMIC_SPLIT = /\[(.+?\(.+?\)|.+?)\]/;
const ROUTE_SPREAD = /^\.{3}.+$/;
export function getParts(part: string) {
	const result: RoutePart[] = [];
	part.split(ROUTE_DYNAMIC_SPLIT).map((str, i) => {
		if (!str) return;
		const dynamic = i % 2 === 1;

		const [, content] = dynamic ? /([^(]+)$/.exec(str) || [null, null] : [null, str];

		if (!content || (dynamic && !/^(?:\.\.\.)?[\w$]+$/.test(content))) {
			throw new Error('Parameter name must match /^[a-zA-Z0-9_$]+$/');
		}

		result.push({
			content,
			dynamic,
			spread: dynamic && ROUTE_SPREAD.test(content),
		});
	});

	return result;
}

async function writeRoutesFileToOutDir(
	_config: AstroConfig,
	logger: AstroIntegrationLogger,
	include: string[],
	exclude: string[]
) {
	try {
		await writeFile(
			new URL('./_routes.json', _config.outDir),
			JSON.stringify(
				{
					version: 1,
					include: include,
					exclude: exclude,
				},
				null,
				2
			),
			'utf-8'
		);
	} catch (error) {
		logger.error("There was an error writing the '_routes.json' file to the output directory.");
	}
}

function segmentsToCfSyntax(segments: IntegrationRouteData['segments'], _config: AstroConfig) {
	const pathSegments = [];
	if (removeLeadingForwardSlash(removeTrailingForwardSlash(_config.base)).length > 0) {
		pathSegments.push(removeLeadingForwardSlash(removeTrailingForwardSlash(_config.base)));
	}
	for (const segment of segments.flat()) {
		if (segment.dynamic) pathSegments.push('*');
		else pathSegments.push(segment.content);
	}
	return pathSegments;
}

class TrieNode {
	children = new Map<string, TrieNode>();
	isEndOfPath = false;
	hasWildcardChild = false;
}

class PathTrie {
	root: TrieNode;
	returnHasWildcard = false;

	constructor() {
		this.root = new TrieNode();
	}

	insert(path: string[]) {
		let node = this.root;
		for (const segment of path) {
			if (segment === '*') {
				node.hasWildcardChild = true;
				break;
			}
			if (!node.children.has(segment)) {
				node.children.set(segment, new TrieNode());
			}

			// biome-ignore lint/style/noNonNullAssertion: The `if` condition above ensures that the segment exists inside the map
			node = node.children.get(segment)!;
		}

		node.isEndOfPath = true;
	}

	/**
	 * Depth-first search (dfs), traverses the "graph"  segment by segment until the end or wildcard (*).
	 * It makes sure that all necessary paths are returned, but not paths with an existing wildcard prefix.
	 * e.g. if we have a path like /foo/* and /foo/bar, we only want to return /foo/*
	 */
	private dfs(node: TrieNode, path: string[], allPaths: string[][]): void {
		if (node.hasWildcardChild) {
			this.returnHasWildcard = true;
			allPaths.push([...path, '*']);
			return;
		}

		if (node.isEndOfPath) {
			allPaths.push([...path]);
		}

		for (const [segment, childNode] of node.children) {
			this.dfs(childNode, [...path, segment], allPaths);
		}
	}

	getAllPaths(): [string[][], boolean] {
		const allPaths: string[][] = [];
		this.dfs(this.root, [], allPaths);
		return [allPaths, this.returnHasWildcard];
	}
}

export async function createRoutesFile(
	_config: AstroConfig,
	logger: AstroIntegrationLogger,
	routes: IntegrationRouteData[],
	pages: {
		pathname: string;
	}[],
	redirects: IntegrationRouteData['segments'][],
	includeExtends:
		| {
				pattern: string;
		  }[]
		| undefined,
	excludeExtends:
		| {
				pattern: string;
		  }[]
		| undefined
) {
	const includePaths: string[][] = [];
	const excludePaths: string[][] = [];

	/**
	 * All files in the `_config.build.assets` path, e.g. `_astro`
	 * are considered static assets and should not be handled by the function
	 * therefore we exclude a wildcard for that, e.g. `/_astro/*`
	 */
	const assetsPath = segmentsToCfSyntax(
		[
			[{ content: _config.build.assets, dynamic: false, spread: false }],
			[{ content: '', dynamic: true, spread: false }],
		],
		_config
	);
	excludePaths.push(assetsPath);

	for (const redirect of redirects) {
		excludePaths.push(segmentsToCfSyntax(redirect, _config));
	}

	if (existsSync(fileURLToPath(_config.publicDir))) {
		const staticFiles = await glob(`${fileURLToPath(_config.publicDir)}/**/*`, {
			cwd: fileURLToPath(_config.publicDir),
			filesOnly: true,
			dot: true,
		});
		for (const staticFile of staticFiles) {
			if (['_headers', '_redirects', '_routes.json'].includes(staticFile)) continue;
			const staticPath = staticFile;

			const segments = removeLeadingForwardSlash(staticPath)
				.split(posix.sep)
				.filter(Boolean)
				.map((s: string) => {
					return getParts(s);
				});
			excludePaths.push(segmentsToCfSyntax(segments, _config));
		}
	}

	let hasPrerendered404 = false;
	for (const route of routes) {
		const convertedPath = segmentsToCfSyntax(route.segments, _config);
		if (route.pathname === '/404' && route.prerender === true) hasPrerendered404 = true;

		switch (route.type) {
			case 'page':
				if (route.prerender === false) includePaths.push(convertedPath);

				break;

			case 'endpoint':
				if (route.prerender === false) includePaths.push(convertedPath);
				else excludePaths.push(convertedPath);

				break;

			case 'redirect':
				excludePaths.push(convertedPath);

				break;

			default:
				/**
				 * We don't know the type, so we are conservative!
				 * Invoking the function on these is a safe-bet because
				 * the function will fallback to static asset fetching
				 */
				includePaths.push(convertedPath);

				break;
		}
	}

	for (const page of pages) {
		if (page.pathname === '404') hasPrerendered404 = true;
		const pageSegments = removeLeadingForwardSlash(page.pathname)
			.split(posix.sep)
			.filter(Boolean)
			.map((s) => {
				return getParts(s);
			});
		excludePaths.push(segmentsToCfSyntax(pageSegments, _config));
	}

	const includeTrie = new PathTrie();
	for (const includePath of includePaths) {
		includeTrie.insert(includePath);
	}
	const [deduplicatedIncludePaths, includedPathsHaveWildcard] = includeTrie.getAllPaths();

	const excludeTrie = new PathTrie();
	for (const excludePath of excludePaths) {
		/**
		 * A excludePath with starts with a wildcard (*) is a catch-all
		 * that would mean all routes are static, that would be equal to a full SSG project
		 * the adapter is not needed in this case, so we do not consider such paths
		 */
		if (excludePath[0] === '*') continue;
		excludeTrie.insert(excludePath);
	}
	const [deduplicatedExcludePaths, _excludedPathsHaveWildcard] = excludeTrie.getAllPaths();

	/**
	 * Cloudflare allows no more than 100 include/exclude rules combined
	 * https://developers.cloudflare.com/pages/functions/routing/#limits
	 */
	const CLOUDFLARE_COMBINED_LIMIT = 100;
	/**
	 * Caluclate the number of automated and extended include rules
	 */
	const AUTOMATIC_INCLUDE_RULES_COUNT = deduplicatedIncludePaths.length;
	const EXTENDED_INCLUDE_RULES_COUNT = includeExtends?.length ?? 0;
	const INCLUDE_RULES_COUNT = AUTOMATIC_INCLUDE_RULES_COUNT + EXTENDED_INCLUDE_RULES_COUNT;
	/**
	 * Caluclate the number of automated and extended exclude rules
	 */
	const AUTOMATIC_EXCLUDE_RULES_COUNT = deduplicatedExcludePaths.length;
	const EXTENDED_EXCLUDE_RULES_COUNT = excludeExtends?.length ?? 0;
	const EXCLUDE_RULES_COUNT = AUTOMATIC_EXCLUDE_RULES_COUNT + EXTENDED_EXCLUDE_RULES_COUNT;

	if (
		!hasPrerendered404 ||
		INCLUDE_RULES_COUNT > CLOUDFLARE_COMBINED_LIMIT ||
		EXCLUDE_RULES_COUNT > CLOUDFLARE_COMBINED_LIMIT
	) {
		await writeRoutesFileToOutDir(
			_config,
			logger,
			['/*'].concat(includeExtends?.map((entry) => entry.pattern) ?? []),
			deduplicatedExcludePaths
				.map((path) => `${prependForwardSlash(path.join('/'))}`)
				.slice(
					0,
					CLOUDFLARE_COMBINED_LIMIT -
						EXTENDED_INCLUDE_RULES_COUNT -
						EXTENDED_EXCLUDE_RULES_COUNT -
						1
				)
				.concat(excludeExtends?.map((entry) => entry.pattern) ?? [])
		);
	} else {
		await writeRoutesFileToOutDir(
			_config,
			logger,
			deduplicatedIncludePaths
				.map((path) => `${prependForwardSlash(path.join('/'))}`)
				.concat(includeExtends?.map((entry) => entry.pattern) ?? []),
			includedPathsHaveWildcard
				? deduplicatedExcludePaths
						.map((path) => `${prependForwardSlash(path.join('/'))}`)
						.concat(excludeExtends?.map((entry) => entry.pattern) ?? [])
				: []
		);
	}
}
