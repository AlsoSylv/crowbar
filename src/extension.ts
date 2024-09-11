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

type CargoFile = {
	dependencies_start: number,
	dependencies_end: number,
	multiline_dependencies: Array<MultilineDep>
}

type MultilineDep = {
	start_line: number,
	end_line: number,
	name: string,
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
			let list = new vscode.CompletionList();

			function parse_multiline_dep(document: vscode.TextDocument, name: string, i: number): MultilineDep {
				let end_line = document.lineCount;

				for(let j = i + 1; j < document.lineCount; j++) {
					const current_line = document.lineAt(j);
					if (current_line.isEmptyOrWhitespace) {
						continue;
					}
	
					const first_char_idex = current_line.firstNonWhitespaceCharacterIndex;
					const first_char = current_line.text.charAt(first_char_idex);
					if (first_char === '[') {
						end_line = j;
						i = j;
						break;
					}
				}

				return { start_line: i, end_line, name, };
			}

			function parse_cargo_toml(document: vscode.TextDocument): CargoFile {
				let dependencies_start: number = -1;
				let dependencies_end: number = document.lineCount;
	
				let multiline_dependencies: MultilineDep[] = new Array();
	
				for(let i = 0; i < document.lineCount; i++) {
					const current_line = document.lineAt(i);
	
					if (current_line.isEmptyOrWhitespace) {
						continue;
					}
	
					const first_char_idex = current_line.firstNonWhitespaceCharacterIndex;
					const first_char = current_line.text.charAt(first_char_idex);
	
					if (first_char === '[') {
						if (dependencies_start !== -1 && dependencies_end === document.lineCount) {
							dependencies_end = i;
						}
	
						if (current_line.text.charAt(first_char_idex + 1) === 'd') {
							let normalized = current_line.text.replace('[', '').replace(']', '').split('.');
	
							let key = normalized[0];
							let maybe_name = normalized[1];
	
							if (maybe_name === undefined && key === "dependencies") {
								dependencies_start = i;
							} else if (maybe_name !== undefined && key === "dependencies") {
								multiline_dependencies.push(parse_multiline_dep(document, maybe_name, i));
							}
						}
					}
				}

				return {
					dependencies_start,
					dependencies_end,
					multiline_dependencies,
				};
			}
			
			let cargo_file = parse_cargo_toml(document);

			if (position.line > cargo_file.dependencies_start && position.line < cargo_file.dependencies_end) {
				let current = document.lineAt(idx);
				let raw_text = current.text;
				let index = raw_text.indexOf('=');
				list.isIncomplete = index === -1;

				if (index === -1) {
					await crates_io_search(raw_text.trim(), list, SearchCache, false, true, position);
				} else {
					let space_index = raw_text.indexOf(' ');
					let name = raw_text.substring(0, space_index > -1 ? index : space_index);
					let object = raw_text.substring(index + 1).trim();

					let maybe_cached = IndexCache.get(name);

					if (object.length === 0 || (object.startsWith('"') && object.endsWith('"'))) {
						await get_crate_versions(name, list, maybe_cached, IndexCache);
					} else if (object.startsWith('{')) {
						if (object.endsWith('}')) {
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
						} else {
							// TODO: Support multiline object statements, even if they're bad and I don't like them :(
						}
					}
				}
			} else {
				for(let {start_line, end_line, name} of cargo_file.multiline_dependencies) {
					let version_line = -1;
					let crate_version = "";
					let features_start_line = -1;
					let feature_start_char = -1;
					let features_end_line = -1;
					let feature_end_char = -1;
					let features_has_end = false;

					// TODO: Promote this loop to part of initial document parsing
					for(let i = start_line + 1; i < end_line; i++) {
						const current_document_line: vscode.TextLine = document.lineAt(i);
						const current_text: string = current_document_line.text;
						const first_char_index = current_document_line.firstNonWhitespaceCharacterIndex;
						const first_char = current_text.charAt(first_char_index);

						if (first_char === 'v') {
							const equals_index = current_text.indexOf('=');

							if (current_text.substring(first_char_index, equals_index).trim() === "version") {
								version_line = i;
								crate_version = current_text.substring(current_text.indexOf('"', equals_index) + 1, current_text.lastIndexOf('"')).trim();
							}
						}

						if (first_char === 'f') {
							const equals_index = current_text.indexOf('=');

							if (current_text.substring(first_char_index, equals_index).trim() === "features") {
								features_start_line = i;
								feature_start_char = current_text.indexOf('[');
							}
						}

						if (features_start_line !== -1 && features_end_line === -1) {
							if (current_text.trimEnd().endsWith(']')) {
								features_end_line = i;
								features_has_end = true;
								feature_end_char = current_text.indexOf(']');
							}
						}

						if (first_char === '[') {
							break;
						}
					}

					if (position.line === start_line) {
						let text = document.lineAt(start_line).text;
						let before_cursor = text.substring(0, position.character);
						let after_cursor = text.substring(position.character);

						if (before_cursor.includes('.') && after_cursor.includes(']')) {
							list.isIncomplete = true;

							await crates_io_search(name, list, SearchCache, true, version_line === -1, new vscode.Position(position.line, text.length + 1));
						}
					} else {
						list.isIncomplete = false;
						let maybe_cached = IndexCache.get(name);

						const within_feature_start = position.line >= features_start_line && position.character > feature_start_char;
						const within_feature_end = position.line <= features_end_line && position.character <= feature_end_char;

						if (position.line === version_line) {
							await get_crate_versions(name, list, maybe_cached, IndexCache);
						} else if (within_feature_start && (within_feature_end || !features_has_end)) {
							const json = await get_or_insert_cached_index(name, maybe_cached, IndexCache);
							const full_version = crate_version.split('.').length < 3;

							const version = json.versions.find((elem) => full_version ? elem.num === crate_version : elem.num.startsWith(crate_version))!;
						
							const features = Object.keys(version.features);
						
							for(let feature of features) {
								list.items.push({
									label: feature,
									insertText: '"' + feature + '"',
								});
							}
						}
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
	console.log(containing_cursor);
	if (containing_cursor.includes('[') && current_pos <= raw_text.indexOf(']', current_pos)) {
		console.log("Looking for features");
		let version_index = object.indexOf('version');
		let crate_version_index = object.indexOf('"', version_index) + 1;
		let crate_version_index_end = object.indexOf('"', crate_version_index);
		let crate_version = object.substring(crate_version_index, crate_version_index_end);

		let version;

		if (crate_version.split('.').length < 3) {
			version = json.versions.find((elem) => elem.num.startsWith(crate_version))!;
		} else {
			version = json.versions.find((element) => element.num === crate_version)!;
		}

		let features = Object.keys(version.features);

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

async function crates_io_search(name: string, completionList: vscode.CompletionList, SearchCache: TTLCache<string, crateSearch>, insert_version_at_end: boolean, insert_version: boolean, insert_position: vscode.Position) {
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

		let additional_text = insert_version_at_end && insert_version ? '\nversion = "' + version + '"' : '';
		let version_text = insert_version_at_end ? '' : " = " + '"' + version + '"';

		completionList.items.push({
			label: {
				label: crate.name,
				description: crate.description,
				detail: " = " + version
			},
			insertText: crate.name + version_text,
			additionalTextEdits: [{
				newText: additional_text,
				range: new vscode.Range(
					insert_position, 
					new vscode.Position(insert_position.line, insert_position.character + additional_text.length)
				),
			}]
		});
	}
}

// This method is called when your extension is deactivated
// export function deactivate() {}
