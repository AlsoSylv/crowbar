export type CrateSearch =  {
	crates: CrateSearchObject[],
	meta: any,
}

export type CrateSearchObject = {
	name: string,
	description: string,
	max_stable_version: string | undefined,
	newest_version: string,
}

export type CrateIndex = {
	versions: CrateIndexObject[]
}

export type CrateIndexObject = {
	num: string,
	crate: string,
	features: object,
}

export type CargoFile = {
	dependencies_start: number,
	dependencies_end: number,
	multiline_dependencies: Array<MultilineDep>
}

export type MultilineDep = {
	start_line: number,
	end_line: number,
	name: string,
	version_line: number,
	feature_start_line: number,
	feature_end_line: number,
	feature_start_char: number,
	feature_end_char: number,
}