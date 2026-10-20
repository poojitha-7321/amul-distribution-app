import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, FileSpreadsheet, FileText, History, Plus, Send, Trash2, Upload } from 'lucide-react';
import { api, del, get, post } from '../../api';
import { fmtDateTime } from '../../format';
import { Button, Card, ConfirmButton, ErrorBox, PageHeader, Pill, Spinner, cx, useToast } from '../../ui';

interface Msg { id?: number; role: 'user' | 'assistant'; content: string; steps?: { tool: string; args: any; ok: boolean }[]; meta?: any }

const SUGGESTIONS = [
  'Give me a summary of this data',
  'Which products sell the most?',
  'Which retailer buys the most?',
  'Show the monthly trend',
  'Are there any unusual values or gaps?',
];

function Answer({ text }: { text: string }) {
  return (
    <div className="prose-answer text-[15px] leading-relaxed [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-slate-50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc">
      <div className="overflow-x-auto"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>
    </div>
  );
}

export default function Assistant() {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const fileInput = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [threadId, setThreadId] = useState<number | undefined>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [showFiles, setShowFiles] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  const status = useQuery({ queryKey: ['assistant-status'], queryFn: () => get('/admin/assistant/status') });
  const files = useQuery({
    queryKey: ['assistant-files'], queryFn: () => get('/admin/assistant/files'),
    // Scanned PDFs are read in the background: keep checking until they are done.
    refetchInterval: (q: any) => (q.state.data?.files?.some((f: any) => f.status === 'processing') ? 5000 : false),
  });
  const threads = useQuery({ queryKey: ['assistant-threads'], queryFn: () => get('/admin/assistant/threads'), enabled: showHistory });

  // Returning from Google's consent screen
  useEffect(() => {
    const d = params.get('drive');
    if (!d) return;
    if (d === 'connected') toast.success('Google Drive connected');
    else toast.error(new Error(params.get('msg') || 'Could not connect Google Drive'));
    void qc.invalidateQueries({ queryKey: ['assistant-status'] });
    setParams({}, { replace: true });
  }, [params, setParams, qc, toast]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const connect = useMutation({
    mutationFn: () => post('/admin/assistant/drive/connect'),
    onSuccess: (r: any) => { window.location.href = r.url; },
    onError: toast.error,
  });
  const disconnect = useMutation({
    mutationFn: () => post('/admin/assistant/drive/disconnect'),
    onSuccess: () => { toast.success('Google Drive disconnected'); void qc.invalidateQueries({ queryKey: ['assistant-status'] }); },
    onError: toast.error,
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api('/admin/assistant/files', { form });
    },
    onSuccess: (r: any) => {
      if (r.processing) toast.success(`Reading the scanned file "${r.file.name}"… this can take a few minutes. You can keep using the app.`);
      else toast.success(r.file.driveLink ? `Saved "${r.file.name}" to Google Drive` : `Added "${r.file.name}"`);
      if (r.warning) toast.error(new Error(r.warning));
      if (!r.processing) setSelected((s) => [...s, r.file.id]);
      void qc.invalidateQueries({ queryKey: ['assistant-files'] });
    },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/admin/assistant/files/${id}`),
    onSuccess: (_r, id) => { setSelected((s) => s.filter((x) => x !== id)); void qc.invalidateQueries({ queryKey: ['assistant-files'] }); toast.success('Removed (the Google Drive copy is kept)'); },
    onError: toast.error,
  });

  const ask = useMutation({
    mutationFn: (q: string) => post('/admin/assistant/chat', { threadId, message: q, fileIds: selected.length ? selected : undefined }),
    onSuccess: (r: any) => {
      setThreadId(r.threadId);
      setMessages((m) => [...m, { role: 'assistant', content: r.message.content, steps: r.message.steps }]);
      void qc.invalidateQueries({ queryKey: ['assistant-threads'] });
    },
    onError: (e) => { toast.error(e); setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${(e as Error).message}` }]); },
  });

  const send = (q: string) => {
    const t = q.trim();
    if (!t || ask.isPending) return;
    setMessages((m) => [...m, { role: 'user', content: t }]);
    setText('');
    ask.mutate(t);
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); send(text); };

  const openThread = async (id: number) => {
    try {
      const r = await get(`/admin/assistant/threads/${id}`);
      setThreadId(id);
      setMessages(r.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content, steps: m.meta?.steps })));
      setShowHistory(false);
    } catch (e) { toast.error(e); }
  };
  const newChat = () => { setThreadId(undefined); setMessages([]); setShowHistory(false); };

  const st = status.data;
  const list: any[] = files.data?.files ?? [];
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const ready = st?.ai.configured;

  if (status.isLoading) return <Spinner />;
  if (status.error) return <ErrorBox error={status.error} retry={() => status.refetch()} />;

  return (
    <div>
      <PageHeader title="AI Assistant" subtitle="Upload files, then ask questions. Files are saved to your Google Drive."
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => setShowHistory((s) => !s)}><History className="size-4" /> History</Button>
          <Button size="sm" variant="secondary" onClick={newChat}><Plus className="size-4" /> New chat</Button>
        </>} />

      {!st.ai.configured && <div className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">The AI is not set up on the server yet. Add a free Groq key as <code>GROQ_API_KEY</code> in Render (see the README).</div>}

      <Card className="mb-3 flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm">
          <div className="font-semibold text-brand-900">Google Drive</div>
          {st.drive.connected ? (
            <div className="text-muted">Connected as <strong>{st.drive.email || 'your account'}</strong>. Files go to the “{st.drive.folderName}” folder. {st.drive.folderUrl && <a href={st.drive.folderUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline">Open folder</a>}</div>
          ) : st.drive.configured ? (
            <div className="text-muted">Not connected. You can still upload files for analysis; connect to also save a copy of each upload to your Drive.</div>
          ) : (
            <div className="text-amber-800">Not set up on the server yet (needs <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>).</div>
          )}
        </div>
        {st.drive.connected
          ? <ConfirmButton size="sm" variant="secondary" message="Disconnect Google Drive? Existing files stay in your Drive, but new uploads will not be copied to Drive until you reconnect." onConfirm={() => disconnect.mutate()}>Disconnect</ConfirmButton>
          : <Button size="sm" disabled={!st.drive.configured} loading={connect.isPending} onClick={() => connect.mutate()}>Connect Google Drive</Button>}
      </Card>

      {showHistory && (
        <Card className="mb-3 p-3">
          <div className="mb-2 text-sm font-semibold">Previous conversations</div>
          {threads.isLoading ? <Spinner /> : (threads.data?.threads ?? []).length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {threads.data.threads.map((t: any) => (
                <li key={t.id}><button onClick={() => openThread(t.id)} className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm hover:bg-slate-50"><span className="truncate">{t.title}</span><span className="shrink-0 text-xs text-muted">{fmtDateTime(t.updated_at)}</span></button></li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* Files */}
        <Card className="h-fit p-4">
          <button className="flex w-full items-center justify-between lg:cursor-default" onClick={() => setShowFiles((s) => !s)} aria-expanded={showFiles}>
            <span className="font-bold text-brand-900">Your files ({list.length})</span>
            <span className="text-sm text-brand-700 lg:hidden">{showFiles ? 'Hide' : 'Show'}</span>
          </button>
          <div className={cx('mt-3 space-y-3', !showFiles && 'hidden lg:block')}>
            <label className={cx('flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed p-3 text-center text-sm', 'border-brand-200 bg-brand-50/50 text-brand-800')}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) upload.mutate(f); }}>
              {upload.isPending ? <Spinner label="Saving and reading…" /> : (<><Upload className="size-6" /><span className="font-semibold">Upload a file</span><span className="text-xs">CSV, Excel, PDF or text · up to 10 MB</span></>)}
              <input ref={fileInput} type="file" accept=".csv,.tsv,.xlsx,.pdf,.txt,.md,.json" disabled={upload.isPending} className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); if (fileInput.current) fileInput.current.value = ''; }} />
            </label>
            {files.isLoading ? <Spinner /> : list.length === 0 ? <p className="py-3 text-center text-sm text-muted">No files yet.</p> : (
              <ul className="space-y-2">
                {list.map((f) => (
                  <li key={f.id} className="rounded-xl border border-line p-2.5">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input type="checkbox" className="mt-1 size-5" disabled={f.status !== 'ready'} checked={selected.includes(f.id)} onChange={() => toggle(f.id)} aria-label={`Use ${f.name} in questions`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-semibold">{f.kind === 'table' ? <FileSpreadsheet className="size-4 shrink-0 text-emerald-600" /> : <FileText className="size-4 shrink-0 text-brand-600" />}<span className="truncate">{f.name}</span></span>
                        <span className="block text-xs text-muted">{f.kind === 'table' ? `${f.rowCount.toLocaleString('en-IN')} rows · ${f.sheets?.length ?? 1} sheet(s)` : 'Document'} · {fmtDateTime(f.createdAt)}</span>
                        {f.status === 'processing' && <span className="block text-xs font-medium text-amber-700">Reading the scan… this can take a few minutes</span>}
                        {f.status === 'failed' && <span className="block text-xs font-medium text-red-700">Could not read this file: {f.error}</span>}
                      </span>
                    </label>
                    <div className="mt-1 flex justify-end gap-1">
                      {f.driveLink && <a href={f.driveLink} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-brand-700 hover:bg-brand-50"><ExternalLink className="size-3.5" /> Drive</a>}
                      <ConfirmButton size="sm" variant="ghost" message={`Remove "${f.name}" from the assistant? The copy in Google Drive is kept.`} onConfirm={() => remove.mutate(f.id)} aria-label={`Remove ${f.name}`}><Trash2 className="size-4 text-slate-400" /></ConfirmButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">{selected.length ? `Questions will use the ${selected.length} ticked file(s).` : 'Nothing ticked: questions use your 8 most recent files.'}</p>
          </div>
        </Card>

        {/* Chat */}
        <Card className="flex min-h-[28rem] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
            {messages.length === 0 && (
              <div className="py-6 text-center">
                <div className="mb-1 text-3xl">📊</div>
                <p className="font-semibold text-brand-900">Ask anything about your files</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Numbers are calculated from your data, not guessed. Try one of these:</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => <button key={s} disabled={!ready || list.length === 0} onClick={() => send(s)} className="min-h-10 rounded-full border border-line px-3 text-sm hover:bg-brand-50 disabled:opacity-40">{s}</button>)}
                </div>
                {ready && list.length === 0 && <p className="mt-3 text-sm text-amber-700">Upload a file first.</p>}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cx('max-w-[92%] rounded-2xl px-4 py-2.5', m.role === 'user' ? 'bg-brand-700 text-white' : 'bg-slate-100 text-ink')}>
                  {m.role === 'user' ? <p className="whitespace-pre-wrap text-[15px]">{m.content}</p> : <Answer text={m.content} />}
                  {m.steps && m.steps.length > 0 && (
                    <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">How this was calculated ({m.steps.length} step{m.steps.length > 1 ? 's' : ''})</summary>
                      <ul className="mt-1 space-y-1">{m.steps.map((s, k) => <li key={k} className="break-all"><Pill tone={s.ok ? 'green' : 'red'}>{s.tool}</Pill> <code>{JSON.stringify(s.args)}</code></li>)}</ul>
                    </details>
                  )}
                </div>
              </div>
            ))}
            {ask.isPending && <div className="flex justify-start"><div className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-muted"><Spinner label="Analysing your data…" /></div></div>}
            <div ref={endRef} />
          </div>
          <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-line p-3">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={2000} aria-label="Your question" placeholder={ready ? 'Ask about your files…' : 'Connect Google Drive and upload a file first'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }}
              className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-line px-3 py-2.5 focus:border-brand-500" />
            <Button type="submit" aria-label="Send" disabled={!text.trim() || ask.isPending || !st.ai.configured} className="size-11 !px-0"><Send className="size-5" /></Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
