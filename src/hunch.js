import MiniSearch from 'minisearch'

const DEFAULT_PAGE_SIZE = 15
const EMPTY_RESULTS = {
	items: [],
	page: {
		items: 0,
		offset: 0,
		pages: 0,
	},
}

const shouldExitEarlyForEmptySet = (metadataToFiles, params) => {
	// TODO add to "boost" tests
	if (params.boost)
		for (const key in params.boost)
			if (!metadataToFiles[key]) return true
	// TODO add to "facets" tests
	if (params.facets)
		for (const key in params.facets)
			if (!metadataToFiles[key]) return true
			else if (!params.facets[key].find(f => metadataToFiles[key][f])) return true
}

const filterDocuments = params => {
	const include = params.facetInclude || {}
	const exclude = params.facetExclude || {}
	return document => {
		let matches = true
		for (const name in include) {
			if (!document[name]) matches = false
			else for (const value of include[name]) {
				if (Array.isArray(document[name])) {
					if (!document[name].includes(value)) matches = false
				} else if (document[name] !== value) {
					matches = false
				}
			}
		}
		for (const name in exclude) for (const value of exclude[name]) {
			if (Array.isArray(document[name])) {
				if (document[name].includes(value)) matches = false
			} else if (document[name] === value) {
				matches = false
			}
		}
		return matches
	}
}

const generateItemsJsChunks = minisearchIndex => {
	const chunks = []
	for (const id in minisearchIndex.storedFields) {
		const documentId = minisearchIndex.documentIds[id]
		const { _content, ...metadata } = minisearchIndex.storedFields[id]
		chunks.push({
			...metadata,
			_id: documentId,
			_content,
		})
	}
	return chunks
}

const unpack = bundle => {
	for (const key in (bundle?.index?.storedFields || {})) {
		bundle.index.storedFields[key]._file = bundle.files[bundle.index.storedFields[key]._file]
	}
	bundle.chunks = generateItemsJsChunks(bundle.index)
	bundle.fileIdToIndex = {}
	let index = 0
	for (const fileId of bundle.files) bundle.fileIdToIndex[fileId] = index++
	return bundle
}

export const hunch = ({ index: bundledIndex, sort: prePaginationSort, stopWords, maxPageSize }) => {
	const {
		facets,
		chunks,
		fileIdToIndex,
		index: miniSearchIndex,
		metadata,
		metadataToFiles,
		searchableFields,
		storedFieldKeys,
		storedFields,
	} = unpack(bundledIndex)

	let mini
	const init = () => {
		const fields = [
			...new Set([
				...(searchableFields || []),
				...(facets || []),
				'_file',
				'_content',
			]),
		]
		if (stopWords && Array.isArray(stopWords)) stopWords = new Set(stopWords)
		mini = MiniSearch.loadJS(miniSearchIndex, {
			idField: '_id',
			fields,
			storeFields: fields,
			...(
				typeof stopWords?.has === 'function'
					? { processTerm: term => stopWords.has(term) ? null : term.toLowerCase() }
					: {}
			),
		})
	}

	return query => {
		// If for example you specify `facet[tags]=cats` and there are no documents
		// containing that tag, we can just short circuit and exit early.
		if (shouldExitEarlyForEmptySet(metadataToFiles, query)) return EMPTY_RESULTS

		// TODO should support request document by id (filename)???

		let searchResults = []
		if (!query.q && !query.suggest) {
			for (const documentId in miniSearchIndex.storedFields) {
				const item = { ...miniSearchIndex.storedFields[documentId] }
				item.id = miniSearchIndex.documentIds[documentId]
				item.score = 0
				searchResults.push(item)
			}
		} else {
			if (!mini) init()
			if (query.suggest) return {
				suggestions: mini
					.autoSuggest(query.q || '')
					.map(({ suggestion: q, score }) => ({
						q,
						score: Math.round(score * 1000) / 1000,
					})),
			}
			if (query.q) {
				const miniOptions = {}
				if (query.facetInclude || query.facetExclude) miniOptions.filter = filterDocuments(query)
				// These few properties are named exactly the same as
				// the MiniSearch properties, so we can direct copy.
				for (const key of [ 'boost', 'fields', 'fuzzy', 'prefix' ]) if (query[key]) miniOptions[key] = query[key]
				searchResults = mini.search(query.q, miniOptions)
			}
		}
		if (!searchResults.length) return EMPTY_RESULTS

		// The results from MiniSearch may match more than one chunk, and if that happens we
		// want to limit the returned items so that if there are multiple chunks in a
		// single file, it doesn't fill the facet bucket with only the one file.
		//
		// This is a novel approach, and it may be misguided--splitting into chunks adds a
		// significant amount of complexity to the search algorithm. I would appreciate any
		// feedback, if you use this functionality.
		//
		// In any case, if you don't use multi-chunk documents, the results will be the same: the
		// list of documents, de-duped by "parent" ID, using the highest scoring chunk.
		const parentIdToChunkId = {}
		const chunkIdToKeep = {}
		for (const result of searchResults) {
			const id = result.id.split(':')[0]
			// for MiniSearch, the first one is the highest scoring, so we just always grab that one
			if (!parentIdToChunkId[id]) {
				parentIdToChunkId[id] = true
				chunkIdToKeep[result.id] = true
			}
		}
		searchResults = searchResults.filter(r => chunkIdToKeep[r.id])
		if (prePaginationSort) searchResults = prePaginationSort({ items: searchResults, query })

		const size = query.pageSize === undefined || query.pageSize < 0
			? DEFAULT_PAGE_SIZE
			: query.pageSize
		const out = {
			items: [],
			page: size === 0
				? { items: searchResults.length }
				: {
					items: searchResults.length,
					offset: query.pageOffset || 0,
					pages: searchResults.length % size
						? Math.round(searchResults.length / size) + 1 // e.g. 12/10=1.2=>Math.round=1=>+1=2 pages
						: searchResults.length / size, // e.g. 12%6=0=>12/6=2 pages
					size,
				},
		}
		if (facets?.length) {
			out.facets = {}
			for (const f of facets) out.facets[f] = {}
		}
		const addToFacets = (facet, key) => out.facets[facet][key] = (out.facets[facet][key] || 0) + 1

		const start = size * out.page.offset // e.g. pageOffset = 3, start = 10*3 = 30
		const end = start + size // e.g. 30+10 = 40
		let index = 0
		for (const { _file, score, id: ignore1, terms: ignore2, match: ignore3, ...props } of searchResults) {
			if (facets?.length) for (const f of facets) if (props[f]) {
				if (Array.isArray(props[f])) for (const p of props[f]) addToFacets(f, p)
				else addToFacets(f, props[f])
			}
			if (index >= start && index < end) out.items.push({ _id: _file, _score: Math.round(score * 1000) / 1000, ...props })
			index++
		}

		if (storedFieldKeys?.length)
			for (const item of out.items)
				for (const key of storedFieldKeys)
					if (storedFields[fileIdToIndex[item._id]]?.[key]) item[key] = storedFields[fileIdToIndex[item._id]][key]

		return out
	}
}
