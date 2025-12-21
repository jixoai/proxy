## 1. Spec & Types
- [ ] Define plugin-scoped UI headers and TS types in `@jixo/proxy-plugin`
- [ ] Extend viewer request metadata to include parsed plugin UI payloads

## 2. Dynamic Stream Support
- [ ] Implement client-side SSE subscription per plugin stream URL
- [ ] Define static-first merge and update logic

## 3. Viewer Integration
- [ ] Render tray icons in RequestList with hover description
- [ ] Render plugin count with tooltip (tray + remark) in RequestList
- [ ] Render tray + remark in RequestDetail

## 4. Plugin Integration
- [ ] Update anthropic-ping to emit static UI payload (tray + remark)
- [ ] Update anthropic-ping to emit dynamic stream URL for keepalive hash

## 5. Tests
- [ ] Unit test header parsing
- [ ] UI render tests for tray + remark (where test infra allows)
