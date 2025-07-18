'use strict'
import { Neovim } from '@chemzqm/neovim'
import { Location, Range, TextDocumentEdit, TextEdit, WorkspaceEdit } from 'vscode-languageserver-types'
import { URI } from 'vscode-uri'
import { IConfigurationChangeEvent } from '../../configuration/types'
import events from '../../events'
import languages, { ProviderName } from '../../languages'
import { disposeAll } from '../../util'
import { getFileLineCount } from '../../util/fs'
import { compareRangesUsingStarts } from '../../util/position'
import { Disposable, Emitter, Event } from '../../util/protocol'
import { emptyWorkspaceEdit } from '../../util/textedit'
import workspace from '../../workspace'
import { HandlerDelegate } from '../types'
import RefactorBuffer, { FileItemDef, FileRangeDef, RefactorConfig, SEPARATOR } from './buffer'
import Search from './search'

const name = '__coc_refactor__'
let refactorId = 0
let srcId: number

export default class Refactor {
  private buffers: Map<number, RefactorBuffer> = new Map()
  public config: RefactorConfig
  private disposables: Disposable[] = []
  private readonly _onCreate = new Emitter<number>()
  public readonly onCreate: Event<number> = this._onCreate.event
  constructor(
    private nvim: Neovim,
    private handler: HandlerDelegate
  ) {
    this.setConfiguration()
    workspace.onDidChangeConfiguration(this.setConfiguration, this, this.disposables)
    events.on('BufUnload', bufnr => {
      let buf = this.buffers.get(bufnr)
      if (buf) {
        buf.dispose()
        this.buffers.delete(bufnr)
      }
    }, null, this.disposables)
    workspace.onDidChangeTextDocument(e => {
      let buf = this.buffers.get(e.bufnr)
      if (buf) buf.onChange(e)
    }, null, this.disposables)
  }

  public has(bufnr: number): boolean {
    return this.buffers.has(bufnr)
  }

  private setConfiguration(e?: IConfigurationChangeEvent): void {
    if (e && !e.affectsConfiguration('refactor')) return
    let config = workspace.getConfiguration('refactor', null)
    this.config = Object.assign(this.config || {}, {
      afterContext: config.get('afterContext', 3),
      beforeContext: config.get('beforeContext', 3),
      openCommand: config.get('openCommand', 'vsplit'),
      saveToFile: config.get('saveToFile', true),
      showMenu: config.get('showMenu', '<Tab>')
    })
  }

  /**
   * Refactor of current symbol
   */
  public async doRefactor(): Promise<void> {
    let { doc, position } = await this.handler.getCurrentState()
    if (!languages.hasProvider(ProviderName.Rename, doc.textDocument)) {
      throw new Error(`Rename provider not found for current buffer`)
    }
    await doc.synchronize()
    let edit = await this.handler.withRequestToken('refactor', async token => {
      let res = await languages.prepareRename(doc.textDocument, position, token)
      if (token.isCancellationRequested) return null
      if (res === false) throw new Error(`Provider returns null on prepare, unable to rename at current position`)
      let edit = await languages.provideRenameEdits(doc.textDocument, position, 'NewName', token)
      if (token.isCancellationRequested) return null
      if (!edit) throw new Error('Provider returns null for rename edits.')
      return edit
    })
    if (edit) {
      await this.fromWorkspaceEdit(edit, doc.filetype)
    }
  }

  /**
   * Search by rg
   */
  public async search(args: string[]): Promise<void> {
    let buf = await this.createRefactorBuffer()
    let cwd = await this.nvim.call('getcwd', []) as string
    let search = new Search(this.nvim)
    await search.run(args, cwd, buf)
  }

  public async save(bufnr: number): Promise<boolean> {
    let buf = this.buffers.get(bufnr)
    if (buf) return await buf.save()
  }

  public getBuffer(bufnr: number): RefactorBuffer {
    return this.buffers.get(bufnr)
  }

  /**
   * Create initialized refactor buffer
   */
  public async createRefactorBuffer(filetype?: string, conceal = false): Promise<RefactorBuffer> {
    let { nvim } = this
    let [fromWinid, cwd] = await nvim.eval('[win_getid(),getcwd()]') as [number, string]
    let { openCommand } = this.config
    if (!nvim.isVim && !srcId) srcId = await this.nvim.createNamespace('coc-refactor')
    nvim.pauseNotification()
    nvim.command(`${openCommand} ${name}${refactorId++}`, true)
    nvim.command(`setl buftype=acwrite nobuflisted bufhidden=wipe nofen wrap conceallevel=2 concealcursor=n`, true)
    nvim.command(`setl undolevels=-1 nolist nospell noswapfile foldmethod=expr foldexpr=coc#util#refactor_foldlevel(v:lnum)`, true)
    nvim.command(`setl foldtext=coc#util#refactor_fold_text(v:foldstart)`, true)
    nvim.call('setline', [1, ['Save current buffer to make changes', SEPARATOR]], true)
    nvim.call('matchadd', ['Comment', '\\%1l'], true)
    nvim.call('matchadd', ['Conceal', '^\\%u3000'], true)
    nvim.call('matchadd', ['Label', '^\\%u3000\\zs\\S\\+'], true)
    nvim.command('setl nomod', true)
    if (filetype) nvim.command(`runtime! syntax/${filetype}.vim`, true)
    nvim.call('coc#util#do_autocmd', ['CocRefactorOpen'], true)
    await nvim.resumeNotification()
    let [bufnr, win] = await nvim.eval('[bufnr("%"),win_getid()]') as [number, number]
    let opts = { fromWinid, winid: win, cwd }
    await workspace.document
    let buf = new RefactorBuffer(bufnr, conceal ? undefined : srcId, this.nvim, this.config, opts)
    this.buffers.set(bufnr, buf)
    return buf
  }

  /**
   * Create refactor buffer from lines
   */
  public async fromLines(lines: string[]): Promise<RefactorBuffer> {
    let buf = await this.createRefactorBuffer()
    await buf.buffer.setLines(lines, { start: 0, end: -1, strictIndexing: false })
    return buf
  }

  /**
   * Create refactor buffer from locations
   */
  public async fromLocations(locations: Location[], filetype?: string): Promise<RefactorBuffer> {
    if (!locations || locations.length == 0) return undefined
    let changes: { [uri: string]: TextEdit[] } = {}
    let edit: WorkspaceEdit = { changes }
    for (let location of locations) {
      let edits: TextEdit[] = changes[location.uri] || []
      edits.push({ range: location.range, newText: '' })
      changes[location.uri] = edits
    }
    return await this.fromWorkspaceEdit(edit, filetype)
  }

  /**
   * Start refactor from workspaceEdit
   */
  public async fromWorkspaceEdit(edit: WorkspaceEdit, filetype?: string): Promise<RefactorBuffer> {
    if (!edit || emptyWorkspaceEdit(edit)) return undefined
    let items: FileItemDef[] = []
    let { beforeContext, afterContext } = this.config
    let { changes, documentChanges } = edit
    const rangesMap: Map<string, Range[]> = new Map()
    if (documentChanges) {
      for (let change of documentChanges || []) {
        if (TextDocumentEdit.is(change)) {
          let { textDocument, edits } = change
          rangesMap.set(textDocument.uri, edits.map(o => o.range))
        }
      }
    } else if (changes) {
      for (let [uri, edits] of Object.entries(changes)) {
        rangesMap.set(uri, edits.map(o => o.range))
      }
    }
    for (let [key, editRanges] of rangesMap.entries()) {
      let max = await this.getLineCount(key)
      let ranges: FileRangeDef[] = []
      // start end highlights
      let start = null
      let end = null
      let highlights: Range[] = []
      editRanges.sort(compareRangesUsingStarts)
      for (let range of editRanges) {
        let { line } = range.start
        let s = Math.max(0, line - beforeContext)
        if (start != null && s < end) {
          end = Math.min(max, line + afterContext + 1)
          highlights.push(adjustRange(range, start))
        } else {
          if (start != null) ranges.push({ start, end, highlights })
          start = s
          end = Math.min(max, line + afterContext + 1)
          highlights = [adjustRange(range, start)]
        }
      }
      if (start != null) ranges.push({ start, end, highlights })
      items.push({ ranges, filepath: URI.parse(key).fsPath })
    }
    let buf = await this.createRefactorBuffer(filetype)
    await buf.addFileItems(items)
    return buf
  }

  private async getLineCount(uri: string): Promise<number> {
    let doc = workspace.getDocument(uri)
    if (doc) return doc.lineCount
    return await getFileLineCount(URI.parse(uri).fsPath)
  }

  public reset(): void {
    for (let buf of this.buffers.values()) {
      buf.dispose()
    }
    this.buffers.clear()
  }

  public dispose(): void {
    this._onCreate.dispose()
    this.buffers.clear()
    disposeAll(this.disposables)
  }
}

function adjustRange(range: Range, offset: number): Range {
  let { start, end } = range
  return Range.create(start.line - offset, start.character, end.line - offset, end.character)
}
