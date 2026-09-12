export interface PublicExportFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface PublicExportResult {
  readonly target: string
  readonly sourceCommit: string
  readonly dirty: boolean
  readonly files: readonly PublicExportFile[]
}

export function exportPublicRepository(outputPath: string): Promise<PublicExportResult>
