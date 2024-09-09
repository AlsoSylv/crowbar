// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { LRUCache } from 'lru-cache';
import TTLCache from '@isaacs/ttlcache';

type crateSearch =  {
	crates: crateSearchObject[],
	meta: any,
}

type crateSearchObject = {
	name: string,
	description: string,
	max_stable_version: string | undefined,
	newest_version: string,
}

type crateIndex = {
	versions: crateIndexObject[]
}

type crateIndexObject = {
	num: string,
	crate: string,
	features: object,
}

const API_URL = new URL("https://crates.io");
const INDEX_URL = new URL("https://index.crates.io");

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "crowbar" is now active!');

	const IndexCache = new LRUCache<string, crateIndex>({
		max: 100,
	});

	const SearchCache = new TTLCache<string, crateSearch>({
		ttl: 3 * 1000 * 60,
		max: 100,
	});

	vscode.languages.registerCompletionItemProvider({ language: "toml", pattern: "**/Cargo.toml" }, {
		async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
			

			let idx = position.line;
			let current_section = null;
			let list = new vscode.CompletionList();

			for(let i = idx; i >= 0; i--) {
				let text = document.lineAt(i).text;
				if (text.startsWith('[')) {
					current_section = text.replace('[', '').replace(']', '').split('.')[0];
					break;
				}
			}

			let current = document.lineAt(idx);

			if (current_section === "dependencies") {
				let raw_text = current.text;
				let index = raw_text.indexOf('=');
				let space_index = raw_text.indexOf(' ');

				list.isIncomplete = index === -1;

				if (index === -1) {
					await crates_io_search(raw_text.trim(), list, SearchCache);
				} else {
					let name = raw_text.substring(0, space_index === -1 ? index : space_index);
					let object = raw_text.substring(index + 1).trim();

					let maybe_cached = IndexCache.get(name);

					if (object.startsWith('{') && object.endsWith('}')) {
						let current_pos = position.character;
						let leading_equals = raw_text.substring(0, current_pos).lastIndexOf('=');
						let containing_cursor = raw_text.substring(leading_equals, current_pos);

						let current_key = get_current_key(raw_text, leading_equals);

						if (current_key === 'version') {
							if (containing_cursor.includes('"') && (!containing_cursor.endsWith('"') || raw_text.charAt(current_pos) === '"')) {	
								await get_crate_versions(name, list, maybe_cached, IndexCache);
							}
						} else if (current_key === 'features') {
							let json = await get_or_insert_cached_index(name, maybe_cached, IndexCache);
							await get_crate_features(raw_text, object, containing_cursor, json, current_pos, list);
						}
						
					} else if (object.length === 0 || (object.startsWith('"') && object.endsWith('"'))) {
						await get_crate_versions(name, list, maybe_cached, IndexCache);
					}
				}
			}

			return list;
		},
		resolveCompletionItem(item, token) {
			return item;
		},
	});

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('crowbar.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from crowbar!');
	});

	context.subscriptions.push(disposable);
}

function get_current_key(raw_text: string, leading_equals: number): string {
	let key_started = false;
	let key_end = -1;
	
	for(let i = leading_equals - 1; i >= 0; i--) {
		let char = raw_text.charAt(i);

		if ((char === ' ' || char === ',' || char === '{') && key_started === true) {
			key_end = i;
			break;
		}

		if (char !== ' ' && key_started === false) {
			key_started = true;
		}
	}

	return raw_text.substring(key_end + 1, leading_equals).trimEnd();
}

async function get_crate_features(raw_text: string, object: string, containing_cursor: string, json: crateIndex, current_pos: number, list: vscode.CompletionList) {
	if (containing_cursor.includes('[') && current_pos <= raw_text.indexOf(']', current_pos)) {
		let version_index = object.indexOf('version');
		let crate_version_index = object.indexOf('"', version_index) + 1;
		let crate_version_index_end = object.indexOf('"', crate_version_index);
		let crate_version = object.substring(crate_version_index, crate_version_index_end);

		let version = json.versions.find((element) => element.num === crate_version);

		let features = Object.keys(version!.features);

		for(let feature of features) {
			list.items.push({
				label: feature,
				insertText: '"' + feature + '"',
			});
		}
	}
}

async function get_or_insert_cached_index(name: string, maybe_cached: crateIndex | undefined, IndexCache: LRUCache<string, crateIndex>): Promise<crateIndex> {
	let url = API_URL;
	url.pathname = `/api/v1/crates/${name}/versions`;

	let json;

	if (maybe_cached === undefined) {
		let index = await fetch(url);
		let fetched_json = await index.json() as { versions: crateIndexObject[] };
		
		IndexCache.set(name, fetched_json);
		json = fetched_json;
	} else {
		json = maybe_cached;
	}
	
	return json;
}

async function get_crate_versions(name: string, list: vscode.CompletionList, maybe_cached: crateIndex | undefined, IndexCache: LRUCache<string, crateIndex>) {
	let json = await get_or_insert_cached_index(name, maybe_cached, IndexCache);

	for(let version of json.versions) {
		list.items.push({
			label: version.num
		});
	}
}

async function crates_io_search(name: string, completionList: vscode.CompletionList, SearchCache: TTLCache<string, crateSearch>) {
	let url = API_URL;
	url.pathname = "/api/v1/crates";
	url.searchParams.set("q", name);

	let maybe_cached = SearchCache.get(name);

	let json;

	if (maybe_cached === undefined) {
		let response = await fetch(url);
		let fetched_json = await response.json() as crateSearch;
		
		SearchCache.set(name, fetched_json);
		json = fetched_json;
	} else {
		json = maybe_cached;
	}
						
	for(let crate of json.crates) {
		let version = crate.max_stable_version ? crate.max_stable_version : crate.newest_version;

		completionList.items.push({
			label: {
				label: crate.name,
				description: crate.description,
				detail: " = " + version
			},
			insertText: crate.name + " = " + '"' + version + '"',
		});
	}
}

// This method is called when your extension is deactivated
// export function deactivate() {}
