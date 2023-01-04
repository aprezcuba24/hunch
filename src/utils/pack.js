/** @typedef {Object} HunchBundlePacked
 * // pass through configs
 * @property {Object} facets
 * @property {Object} searchableFields
 * @property {Object} stopWords
 * @property {Object} storedFields
 * // generated packed data
 * @property {Object} chunkIdToFileIndex
 * @property {Object} chunkMetadata
 * @property {Object} fileIdToDocumentIds
 * @property {Object} fileMetadata
 * @property {Object} filesList
 * // minisearch related
 * @property {Object} miniSearch
 * @property {Object} _minisearchOptions
 */

const packTree = (initialKeys, initialValues, rootAllowedKeys) => {
	const keys = initialKeys || []
	const values = initialValues || []
	const byId = {}
	const recursiveReplacer = obj => {
		let replace
		if (Array.isArray(obj)) {
			replace = []
			for (const elem of obj) {
				replace.push(recursiveReplacer(elem))
			}
		} else if (typeof obj === 'object') {
			replace = {}
			const objectKeys = rootAllowedKeys || Object.keys(obj)
			for (const key of objectKeys) {
				let keyIndex = keys.findIndex(k => k === key)
				if (keyIndex < 0) {
					keyIndex = keys.length
					keys.push(key)
				}
				replace[keyIndex] = recursiveReplacer(obj[key])
			}
		} else if (obj !== undefined) {
			let valueIndex = values.findIndex(v => v === obj)
			if (valueIndex < 0) {
				valueIndex = values.length
				values.push(obj)
			}
			return valueIndex
		}
		return replace
	}
	return {
		add: (id, obj) => byId[id] = recursiveReplacer(obj),
		done: () => ({ keys, values, byId }),
	}
}

/**
 * @return {HunchBundlePacked} The packed bundle.
 */
export const pack = ({
	// pass through configs
	facets,
	searchableFields,
	stopWords,
	storedFields,
	// generated data
	chunkIdToFileIndex,
	chunkMetadata,
	fileToMetadata,
	filesList,
	// minisearch index
	miniSearch,
	_minisearchOptions,
}) => {
	const packed = {
		// pass through configs
		facets,
		searchableFields,
		storedFields,
		filesList,
		// stringify forces the MiniSearch object to convert to
		// a normal object for normal traversal
		miniSearch: JSON.parse(JSON.stringify(miniSearch)),
		_minisearchOptions,
	}

	if (stopWords) packed.stopWords = [ ...new Set(stopWords) ]

	const chunkIdToDocumentId = {}
	for (const documentId in packed.miniSearch.documentIds) chunkIdToDocumentId[packed.miniSearch.documentIds[documentId]] = documentId
	packed.fileIdToDocumentIds = {}
	for (const chunkId in chunkIdToFileIndex) {
		const fileId = chunkIdToFileIndex[chunkId]
		packed.fileIdToDocumentIds[fileId] = packed.fileIdToDocumentIds[fileId] || []
		packed.fileIdToDocumentIds[fileId].push(chunkIdToDocumentId[chunkId])
	}

	const packedChunkMetadata = packTree()
	for (const chunkId in chunkMetadata) packedChunkMetadata.add(chunkId, chunkMetadata[chunkId])
	packed.chunkMetadata = packedChunkMetadata.done()

	const savedMetadataFields = new Set()
	for (const f of (storedFields || [])) savedMetadataFields.add(f)
	for (const f of (facets || [])) savedMetadataFields.add(f)

	const packedFileMetadata = packTree([ ...savedMetadataFields ], [], [ ...savedMetadataFields ])
	for (const fileId in fileToMetadata) packedFileMetadata.add(fileId, fileToMetadata[fileId])
	packed.fileMetadata = packedFileMetadata.done()

	return packed
}
