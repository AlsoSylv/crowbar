import { CancellationToken, CompletionContext, CompletionItem, CompletionItemProvider, Position, ProviderResult, TextDocument } from "vscode";
import * as vscode from 'vscode';
import { CargoFile, CrateIndex, MultilineDep } from "../types";
import Context from "../context";

export class AutoCompletionProvider implements CompletionItemProvider {
  ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async provideCompletionItems(document: TextDocument, position: Position, _token: CancellationToken, _context: CompletionContext) {
    let idx = position.line;
    let list = new vscode.CompletionList();
    let cargo_file = this.parse_cargo_toml(document);

    const inDependencies = position.line > cargo_file.dependencies_start && position.line < cargo_file.dependencies_end;
    if (inDependencies === false) {
      await this.process_cargo_file(cargo_file, document, position, list);
      return list;
    }
    
    let current = document.lineAt(idx);
    let raw_text = current.text;
    let index = raw_text.indexOf('=');
    list.isIncomplete = index === -1;

    if (index === -1) {
      await this.crates_io_search(raw_text.trim(), list, false, true, position);
      return list;
    } 

    let space_index = raw_text.indexOf(' ');
    let name = raw_text.substring(0, space_index > -1 ? space_index : index);
    let object = raw_text.substring(index + 1).trim();

    console.log(object);
    console.log(name);

    if (object.length === 0 || (object.startsWith('"') && object.endsWith('"'))) {
      console.log("h");
      await this.get_crate_versions(name, list);
      return list;
    }

    const curlyEnclosed = object.startsWith('{') && object.endsWith('}');
    if (curlyEnclosed) {
      let current_pos = position.character;
      let leading_equals = raw_text.substring(0, current_pos).lastIndexOf('=');
      let containing_cursor = raw_text.substring(leading_equals, current_pos);

      let current_key = this.get_current_key(raw_text, leading_equals);

      if (current_key === 'version') {
        if (containing_cursor.includes('"') && (!containing_cursor.endsWith('"') || raw_text.charAt(current_pos) === '"')) {	
          await this.get_crate_versions(name, list);
        }
      } else if (current_key === 'features') {
        let json = await this.get_or_insert_cached_index(name);
        await this.get_crate_features(raw_text, object, containing_cursor, json, current_pos, list);
      }

      return list;
    }

    // TODO: Support multiline object statements, even if they're bad and I don't like them :(

    return list;
  }

  resolveCompletionItem?(item: CompletionItem, _token: CancellationToken): ProviderResult<CompletionItem> {
    return item;
  }

  async process_cargo_file(cargo_file: CargoFile, document: vscode.TextDocument, position: vscode.Position, list: vscode.CompletionList<vscode.CompletionItem>) {
    for (let { start_line, end_line, name, version_line, feature_start_line, feature_end_line, feature_start_char, feature_end_char } of cargo_file.multiline_dependencies) {
      let features_has_end = feature_end_line !== -1;
      const version_line_text = document.lineAt(version_line).text;
      const crate_version = version_line_text.substring(version_line_text.indexOf('"') + 1, version_line_text.lastIndexOf('"'));
  
      const lineInBounds = position.line >= start_line || position.line <= end_line;
      if (lineInBounds === false) { return; } 
  
      if (position.line !== start_line) {
        list.isIncomplete = false;
  
        const within_feature_start = position.line === feature_start_line ? position.character > feature_start_char : position.line > feature_start_line;
        const within_feature_end = position.line === feature_end_line ? position.character <= feature_end_char : position.line < feature_end_line;
  
        if (position.line === version_line) {
          await this.get_crate_versions(name, list);
          return;
        } 
        
        if (within_feature_start && (within_feature_end || !features_has_end)) {
          console.log("Within feature");
          const json = await this.get_or_insert_cached_index(name);
          const full_version = crate_version.split('.').length < 3;
  
          const version = json.versions.find((elem) => full_version ? elem.num === crate_version : elem.num.startsWith(crate_version))!;
  
          const features = Object.keys(version.features);
  
          for (let feature of features) {
            list.items.push({
              label: feature,
              insertText: '"' + feature + '"',
            });
          }
        }
        return;
      }
  
      let text = document.lineAt(start_line).text;
      let before_cursor = text.substring(0, position.character);
      let after_cursor = text.substring(position.character);
  
      if (before_cursor.includes('.') && after_cursor.includes(']')) {
        list.isIncomplete = true;
  
        await this.crates_io_search(name, list, true, version_line === -1, new vscode.Position(position.line, text.length + 1));
      }
    }
  }

  parse_multiline_dep(document: vscode.TextDocument, name: string, i: number): [MultilineDep, number] {
    let version_line = -1;
    let feature_start_line = -1;
    let feature_end_line = -1;
    let feature_start_char = -1;
    let feature_end_char = -1;
  
    let end_line = document.lineCount;
  
    let j = i + 1;
  
    for(;j < document.lineCount; j++) {
      const current_line = document.lineAt(j);
      if (current_line.isEmptyOrWhitespace) {
        continue;
      }
  
      const first_char_idex = current_line.firstNonWhitespaceCharacterIndex;
      const first_char = current_line.text.charAt(first_char_idex);
      if (first_char === '[') {
        end_line = j;
        break;
      }
  
      if (current_line.text.startsWith('version', first_char_idex)) {
        version_line = j;
      }
  
      if (current_line.text.startsWith('features', first_char_idex)) {
        feature_start_line = j;
        feature_start_char = current_line.text.indexOf('[');
      }
  
      if (feature_start_line !== -1 && feature_end_line === -1) {
        const maybe_feature_end = current_line.text.trimEnd();
  
        if (maybe_feature_end.endsWith(']')) {
          feature_end_line = j;
          feature_end_char = maybe_feature_end.length;
        }
      }
    }
  
    return [{ start_line: i, end_line, name, version_line, feature_start_line, feature_end_line, feature_start_char, feature_end_char }, j];
  }

  parse_cargo_toml(document: vscode.TextDocument): CargoFile {
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
            const [multiline_dep, new_idx] = this.parse_multiline_dep(document, maybe_name, i);
            multiline_dependencies.push(multiline_dep);
            i = new_idx;
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

  async get_crate_features(raw_text: string, object: string, containing_cursor: string, json: CrateIndex, current_pos: number, list: vscode.CompletionList) {
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

  get_current_key(raw_text: string, leading_equals: number): string {
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

  async get_or_insert_cached_index(name: string): Promise<CrateIndex> {
    const cached = this.ctx.indexCache.get(name);
    if (cached !== undefined) {
      return cached;
    }

    const index = await this.ctx.cratesIo.getIndex(name);
    this.ctx.indexCache.set(name, index);

    return index;
  }

  async get_or_insert_cached_search(name: string) {
    const cached = this.ctx.searchCache.get(name);
    if (cached !== undefined) {
      return cached;
    }

    const search = await this.ctx.cratesIo.getSearch(name);
    this.ctx.searchCache.set(name, search);

    return search;
  }

  async get_crate_versions(name: string, list: vscode.CompletionList) {
    const json = await this.get_or_insert_cached_index(name);
  
    console.log(json);
  
    for(let version of json.versions) {
      list.items.push({
        label: version.num
      });
    }
  }

  async crates_io_search(name: string, completionList: vscode.CompletionList, insert_version_at_end: boolean, insert_version: boolean, insert_position: vscode.Position) {
    const json = await this.ctx.cratesIo.getSearch(name);
              
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
}