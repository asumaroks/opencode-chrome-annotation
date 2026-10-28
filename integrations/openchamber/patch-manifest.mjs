const RENDER_ROWS = '__octm.count()>0&&(me.length>0||oe.length>0||ue.length>0||ke.length>0)&&d.jsx("div",{className:"my-1 border-t border-border/60"}),__octm.rows().map((J,ie)=>{const Y=me.length+oe.length+ue.length+ke.length+ie;return d.jsxs("div",{ref:De=>{$.current[Y]=De},className:G("flex items-center gap-2 px-2 py-1.5 cursor-pointer typography-ui-label rounded-lg",L===Y&&"bg-interactive-selection"),onClick:()=>__octm.select(J),onMouseMove:()=>{N(Y)},children:[d.jsx(X,{name:J.icon??"global",className:"h-3.5 w-3.5 shrink-0 text-muted-foreground"}),d.jsx("span",{className:"max-w-[60%] shrink-0 truncate font-medium",children:J.title}),d.jsx(q0,{description:J.description})]},J.key)}),ue.length===0&&oe.length===0&&me.length===0&&ke.length===0&&__octm.count()===0&&d.jsx("div",{'

const NATIVE_SEAMS = 'globalThis.__octmNative={readComposer:()=>{const e=P.current;if(!e||!nt||!eo)return null;const t=e.getValue(),s=e.getSelection();return{runtimeKey:nt.runtimeKey,directory:nt.directory,sessionId:nt.sessionId??null,draftId:(We?Oe?.draftId:Y)??"",sessionKey:eo.sessionKey,generation:Xc().generation,text:t,caret:s.end}},addDraft:(e,t)=>$r.getState().addDraft(e,t),editRange:(e,t,n)=>{const s=P.current;s&&s.replaceRange(e,t,n)},removeDraft:(e,t)=>$r.getState().removeDraft(e,t)};'

export const SEAM_CONTRACT = Object.freeze({
  version: 1,
  global: "__octmNative",
  readComposer: Object.freeze({
    synchronous: true,
    returns: "object or null",
    nativeFields: Object.freeze({
      runtimeKey: "non-empty string",
      directory: "non-empty string",
      sessionId: "non-empty string or null",
      draftId: "string; empty when the native composer has no draft id yet, the adapter derives octm-<runtimeKey>",
      sessionKey: "non-empty string",
      generation: "integer",
      text: "string",
      caret: "integer within text",
    }),
    adapterFields: Object.freeze({
      from: "start of the active @query, otherwise caret",
      to: "caret",
    }),
  }),
  addDraft: Object.freeze({
    synchronous: true,
    arguments: Object.freeze(["scope {directory, sessionKey}", "payload {source, fileLabel, startLine, endLine, code, language, text}"]),
    returns: "draft id string or null",
  }),
  editRange: Object.freeze({
    synchronous: true,
    arguments: Object.freeze(["from", "to", "insert"]),
    returns: "void",
  }),
  removeDraft: Object.freeze({
    synchronous: true,
    arguments: Object.freeze(["scope {directory, sessionKey}", "draft id"]),
    returns: "void",
  }),
})

export const PATCH_MANIFEST = Object.freeze({
  version: "2.5.2",
  asset: "assets/useAppFontEffects-DFJQ0O1i.js",
  sha256: "4f288a1a01526447321b06f40adf7c2625252f570ecdd3afa1fee739ba860da6",
  adapterGlobal: "__octm",
  offsetSpace: "asset",
  patches: Object.freeze([
    Object.freeze({
      id: "mention-subscribe",
      order: 1,
      scope: "asset",
      purpose: "Re-render the native mention menu when the adapter state changes, so loading, pending and cancel rows appear without an unrelated render.",
      action: "insertAfter",
      marker: "_vt=w.forwardRef(({searchQuery:t,onFileSelect:e,onAgentSelect:n,onSessionSelect:s,onClose:r,style:o},i)=>{",
      insert: "const __octmRev=w.useSyncExternalStore(__octm.subscribe,__octm.getSnapshot,__octm.getSnapshot);",
      occurrences: 1,
      offsets: Object.freeze([2750894]),
    }),
    Object.freeze({
      id: "mention-escape",
      order: 2,
      scope: "fragment",
      fragment: "mentionHandle",
      purpose: "Tell the adapter that the native menu closed on Escape before the native close callback runs.",
      action: "replace",
      marker: 'if(J==="Escape"){r();return}',
      insert: 'if(J==="Escape"){__octm.closeMenu();r();return}',
      occurrences: 1,
      offsets: Object.freeze([2755642]),
    }),
    Object.freeze({
      id: "mention-count",
      order: 3,
      scope: "fragment",
      fragment: "mentionHandle",
      purpose: "Include the chrome rows in the single native mention count so keyboard and mouse share one index.",
      action: "replace",
      marker: "const ie=me.length+ke.length+oe.length+ue.length;",
      insert: "const ie=me.length+ke.length+oe.length+ue.length+__octm.count();",
      occurrences: 1,
      offsets: Object.freeze([2755670]),
    }),
    Object.freeze({
      id: "mention-dispatch",
      order: 4,
      scope: "fragment",
      fragment: "mentionHandle",
      purpose: "Dispatch Enter/Tab on a chrome row after the native session rows, leaving native indices unchanged.",
      action: "replace",
      marker: "const ge=Y-me.length,Ie=oe.length+ue.length;if(ge>=Ie){const De=ke[ge-Ie];De&&s?.(De);return}",
      insert: "const ge=Y-me.length,Ie=oe.length+ue.length;if(ge>=Ie){const De=ge-Ie;if(De<ke.length){const Ne=ke[De];Ne&&s?.(Ne);return}const cr=__octm.rows()[De-ke.length];if(cr){__octm.select(cr);return}}",
      occurrences: 1,
      offsets: Object.freeze([2755933]),
    }),
    Object.freeze({
      id: "mention-render",
      order: 5,
      scope: "asset",
      purpose: "Render the chrome rows as native mention rows after the session rows and keep the empty state for a truly empty menu.",
      action: "replace",
      marker: 'ue.length===0&&oe.length===0&&me.length===0&&ke.length===0&&d.jsx("div",{',
      insert: RENDER_ROWS,
      occurrences: 1,
      offsets: Object.freeze([2760794]),
    }),
    Object.freeze({
      id: "native-seams",
      order: 6,
      scope: "asset",
      purpose: "Publish the live composer and inline draft store handles for the bootstrap runtime, including the synchronous removeDraft compensation seam.",
      action: "insertAfter",
      marker: "const BD=w.useRef(We);",
      insert: NATIVE_SEAMS,
      occurrences: 1,
      offsets: Object.freeze([2882575]),
    }),
    Object.freeze({
      id: "composer-subscribe",
      order: 7,
      scope: "asset",
      purpose: "Re-render the composer when the adapter state changes, so the disabled send control follows a pending capture.",
      action: "replace",
      marker: "wme=(Ih||a7)&&!(we&&(Xe.creating||vme))",
      insert: "wme=(globalThis.__octmRev=w.useSyncExternalStore(__octm.subscribe,__octm.getSnapshot,__octm.getSnapshot),(Ih||a7)&&!(we&&(Xe.creating||vme)))",
      detect: "globalThis.__octmRev=w.useSyncExternalStore(__octm.subscribe,__octm.getSnapshot,__octm.getSnapshot)",
      occurrences: 1,
      offsets: Object.freeze([2883989]),
    }),
    Object.freeze({
      id: "composer-send-button",
      order: 8,
      scope: "asset",
      purpose: "Disable the native send control while a capture is pending.",
      action: "replace",
      marker: "(Ih||a7)&&!(we&&(Xe.creating||vme))",
      insert: "(Ih||a7)&&!__octm.isSendBlocked()&&!(we&&(Xe.creating||vme))",
      occurrences: 1,
      offsets: Object.freeze([2883993]),
    }),
    Object.freeze({
      id: "composer-queue-send-guard",
      order: 9,
      scope: "asset",
      purpose: "Block the queued Send path while a capture is pending.",
      action: "insertAfter",
      marker: "Mh=w.useCallback(async()=>{if(Sh())return;",
      insert: "if(__octm.isSendBlocked())return;",
      occurrences: 1,
      offsets: Object.freeze([2884298]),
    }),
    Object.freeze({
      id: "composer-direct-send-guard",
      order: 10,
      scope: "asset",
      purpose: "Block the direct Send path while a capture is pending.",
      action: "insertAfter",
      marker: "Eh=async K=>{if(Sh()||we&&Y&&(Xe.creating||Fs.getState().byParent[Y]?.pendingSend))return;",
      insert: "if(__octm.isSendBlocked())return;",
      occurrences: 1,
      offsets: Object.freeze([2889009]),
    }),
  ]),
})

export const mentionMenuPatches = PATCH_MANIFEST.patches.filter(patch => patch.scope === "fragment" && patch.fragment === "mentionHandle")

export function orderedPatches(patches = PATCH_MANIFEST.patches) {
  return [...patches].sort((left, right) => left.order - right.order)
}

export function applyPatch(source, patch) {
  const first = source.indexOf(patch.marker)
  if (first < 0) throw new Error(`missing patch marker: ${patch.id}`)
  if (source.indexOf(patch.marker, first + 1) >= 0) throw new Error(`ambiguous patch marker: ${patch.id}`)
  if (patch.action === "replace") return source.slice(0, first) + patch.insert + source.slice(first + patch.marker.length)
  if (patch.action === "insertAfter") return source.slice(0, first + patch.marker.length) + patch.insert + source.slice(first + patch.marker.length)
  if (patch.action === "insertBefore") return source.slice(0, first) + patch.insert + source.slice(first)
  throw new Error(`unknown patch action: ${patch.action}`)
}

export function applyPatches(source, patches = PATCH_MANIFEST.patches) {
  return orderedPatches(patches).reduce((current, patch) => applyPatch(current, patch), source)
}

export function verifyPatchSource(source, patches = PATCH_MANIFEST.patches) {
  const problems = []
  const ordered = orderedPatches(patches)
  let current = source
  for (const patch of ordered) {
    const first = current.indexOf(patch.marker)
    if (first < 0) {
      problems.push(`${patch.id}: marker missing after earlier patches`)
      continue
    }
    const second = current.indexOf(patch.marker, first + 1)
    if (second >= 0) problems.push(`${patch.id}: marker occurs more than once after earlier patches`)
    if (patch.occurrences !== 1) problems.push(`${patch.id}: recorded occurrences is not 1`)
    const absolute = source.indexOf(patch.marker)
    if (!Array.isArray(patch.offsets) || patch.offsets[0] !== absolute) problems.push(`${patch.id}: recorded offset ${patch.offsets?.[0]} does not match ${absolute}`)
    try {
      current = applyPatch(current, patch)
    } catch (error) {
      problems.push(`${patch.id}: ${error.message}`)
    }
  }
  const offsets = new Map()
  for (const patch of ordered) {
    const offset = patch.offsets?.[0]
    if (offset === undefined) continue
    const earlier = offsets.get(offset)
    if (earlier) {
      const compatible = (earlier.action === "insertBefore" || earlier.action === "insertAfter") && patch.action === "replace"
      if (!compatible) problems.push(`${patch.id}: ambiguous same-offset order with ${earlier.id} at ${offset}`)
    } else {
      offsets.set(offset, patch)
    }
  }
  return problems
}

export const ADAPTER_SEAMS = Object.freeze(Object.keys(SEAM_CONTRACT).filter(key => SEAM_CONTRACT[key] && typeof SEAM_CONTRACT[key] === "object" && SEAM_CONTRACT[key].synchronous === true))

export const ADAPTER_API = Object.freeze(Object.assign([
  "init",
  "rows",
  "count",
  "select",
  "isSendBlocked",
  "closeMenu",
  "cancel",
  "invalidate",
  "pair",
  "state",
  "subscribe",
  "getSnapshot",
], {
  seams: ADAPTER_SEAMS,
  contract: SEAM_CONTRACT,
}))
