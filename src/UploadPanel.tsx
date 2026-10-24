import { useEffect, useId, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Radio,
  RadioGroup,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  CloudUpload,
  Plus,
  RotateCw,
  Users,
  X,
} from 'lucide-react';
import {
  errorText,
  formatBytes,
  ttlLabel,
  upload,
  type Config,
  type Member,
  type Room,
} from './api';
import { FileIcon, UserAvatar } from './components';

type Item = {
  id: string;
  file: File;
  status: 'ready' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
};
export default function UploadPanel({
  room,
  members,
  userId,
  config,
  onUploaded,
  onBusy,
}: {
  room: Room;
  members: Member[];
  userId: string;
  config: Config;
  onUploaded: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [audience, setAudience] = useState<'all' | 'selected'>('all');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [draftAudience, setDraftAudience] = useState<'all' | 'selected'>('all');
  const [draftRecipients, setDraftRecipients] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const compact = useMediaQuery('(max-width: 1100px)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const bodyId = useId();
  const otherMembers = members.filter((member) => member.id !== userId);
  function pickRecipients() {
    setDraftAudience(audience);
    setDraftRecipients(recipients);
    setPicker(true);
  }
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current.values()) controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  function choose(files: FileList | File[]) {
    if (running.current) return;
    setError('');
    const list = Array.from(files);
    if (items.length + list.length > config.maxBatchFiles) {
      setError(`每批最多选择 ${config.maxBatchFiles} 个文件，请先移除已完成的文件`);
      return;
    }
    if (list.some((file) => file.size > config.maxFileBytes)) {
      setError(`单个文件不能超过 ${formatBytes(config.maxFileBytes)}`);
      return;
    }
    if (list.some((file) => file.name.length > 240)) {
      setError('文件名不能超过 240 个字符');
      return;
    }
    setItems((previous) => [
      ...previous,
      ...list.map((file) => ({
        id: crypto.randomUUID(),
        file,
        status: 'ready' as const,
        progress: 0,
      })),
    ]);
  }
  function update(id: string, changes: Partial<Item>) {
    if (mounted.current)
      setItems((previous) =>
        previous.map((item) => (item.id === id ? { ...item, ...changes } : item)),
      );
  }
  async function send(onlyId?: string) {
    if (running.current) return;
    if (audience === 'selected' && recipients.length === 0) {
      setError('请至少选择一名接收人');
      pickRecipients();
      return;
    }
    const pending = items.filter((item) =>
      onlyId ? item.id === onlyId : item.status === 'ready' || item.status === 'error',
    );
    if (!pending.length) return;
    running.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    let next = 0;
    const worker = async () => {
      while (next < pending.length && mounted.current) {
        const item = pending[next++];
        const controller = new AbortController();
        controllers.current.set(item.id, controller);
        update(item.id, { status: 'uploading', progress: 0, error: undefined });
        try {
          await upload(
            room.id,
            item.file,
            audience,
            recipients,
            (progress) => update(item.id, { progress }),
            controller.signal,
          );
          update(item.id, { status: 'done', progress: 100 });
          if (mounted.current) onUploaded();
        } catch (error) {
          update(item.id, { status: 'error', error: errorText(error) });
        } finally {
          controllers.current.delete(item.id);
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(config.maxConcurrentUploads, pending.length) }, worker),
      );
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  const ready = items.filter((item) => item.status === 'ready' || item.status === 'error').length;
  const done = items.filter((item) => item.status === 'done').length;
  const queueSummary = busy
    ? `正在发送 · ${done}/${items.length} 已完成`
    : items.length
      ? done === items.length
        ? `${done} 个文件已发送`
        : `${items.length} 个文件 · ${ready} 个待发送`
      : '选择文件，发送给房间成员';
  return (
    <section className="panel upload-panel">
      {compact ? (
        <button
          className="composer-toggle"
          onClick={() => setExpanded((previous) => !previous)}
          aria-expanded={expanded}
          aria-controls={bodyId}
        >
          <span className="composer-toggle-icon">
            <CloudUpload size={21} />
          </span>
          <span>
            <strong>发送文件</strong>
            <small>{queueSummary}</small>
          </span>
          {expanded ? <ChevronUp size={18} /> : <Plus size={20} />}
        </button>
      ) : (
        <div className="section-title">
          <h2>发送文件</h2>
        </div>
      )}
      <Collapse in={!compact || expanded} timeout={reducedMotion ? 0 : 180} id={bodyId}>
        <div className="upload-recipient">
          <span>接收人</span>
          <Button
            color="inherit"
            disabled={busy}
            onClick={pickRecipients}
            startIcon={<Users size={16} />}
            endIcon={<ChevronDown size={15} />}
          >
            {audience === 'all' ? '全体成员' : `${recipients.length} 位指定成员`}
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="选择待发送文件"
          onChange={(event) => {
            if (event.target.files) {
              choose(event.target.files);
              setExpanded(true);
            }
            event.target.value = '';
          }}
        />
        {items.length === 0 && (
          <button
            className={`dropzone ${dragging ? 'dragging' : ''}`}
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              choose(event.dataTransfer.files);
              setExpanded(true);
            }}
          >
            <CloudUpload size={30} strokeWidth={1.5} />
            <strong>选择文件</strong>
            <span>也可拖放到这里</span>
            <small>
              每批最多 {config.maxBatchFiles} 个 · 单文件 {formatBytes(config.maxFileBytes)}
            </small>
          </button>
        )}
        {error && (
          <Alert severity="error" sx={{ mx: 2.5, mb: 2 }}>
            {error}
          </Alert>
        )}
        {items.length > 0 && (
          <div className="upload-queue">
            <div className="queue-heading">
              <strong>
                {done === items.length ? '已发送文件' : '文件队列'} <span>{items.length}</span>
              </strong>
              <Button
                size="small"
                disabled={busy}
                startIcon={<Plus size={14} />}
                onClick={() => input.current?.click()}
              >
                添加
              </Button>
            </div>
            {items.map((item) => (
              <div
                className={`queue-item ${item.status === 'error' ? 'has-error' : ''}`}
                key={item.id}
              >
                <FileIcon name={item.file.name} />
                <div className="queue-info">
                  <strong title={item.file.name}>{item.file.name}</strong>
                  <span role={item.status === 'error' ? 'alert' : undefined}>
                    {item.error ??
                      (item.status === 'done'
                        ? '发送成功'
                        : item.status === 'uploading'
                          ? `正在上传 ${item.progress}%`
                          : formatBytes(item.file.size))}
                  </span>
                  {item.status === 'uploading' && (
                    <LinearProgress
                      aria-label={`${item.file.name} 上传进度`}
                      variant="determinate"
                      value={item.progress}
                    />
                  )}
                </div>
                <div className="queue-item-actions">
                  {item.status === 'done' ? (
                    <Check className="success-icon" size={18} />
                  ) : item.status === 'uploading' ? (
                    <Tooltip title="取消上传">
                      <IconButton
                        aria-label={`取消上传 ${item.file.name}`}
                        size="small"
                        onClick={() => controllers.current.get(item.id)?.abort()}
                      >
                        <X size={17} />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <>
                      {item.status === 'error' && (
                        <Tooltip title="重试">
                          <span>
                            <IconButton
                              aria-label={`重试 ${item.file.name}`}
                              size="small"
                              disabled={busy}
                              onClick={() => send(item.id)}
                            >
                              <RotateCw size={17} />
                            </IconButton>
                          </span>
                        </Tooltip>
                      )}
                      <Tooltip title="移除">
                        <span>
                          <IconButton
                            aria-label={`移除 ${item.file.name}`}
                            size="small"
                            disabled={busy}
                            onClick={() =>
                              setItems((previous) => previous.filter((x) => x.id !== item.id))
                            }
                          >
                            <X size={17} />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
            ))}
            <div className="queue-actions">
              {ready === 0 && !busy ? (
                <>
                  <span className="queue-done">
                    <Check size={16} />
                    发送完成
                  </span>
                  <Button
                    onClick={() => {
                      setItems([]);
                      setError('');
                    }}
                  >
                    完成
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      setItems((previous) => previous.filter((item) => item.status !== 'done'))
                    }
                  >
                    清理已完成
                  </Button>
                  <Button
                    variant="contained"
                    disabled={busy || ready === 0}
                    onClick={() => send()}
                    endIcon={busy ? undefined : <ArrowRight size={16} />}
                  >
                    {busy ? '正在发送…' : `发送 ${ready} 个文件`}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
        <div className="upload-foot">
          <Clock3 size={15} />
          <span>发送成功 {ttlLabel(room.ttlHours)}后自动删除</span>
        </div>
      </Collapse>
      <Dialog open={picker} onClose={() => setPicker(false)} fullWidth maxWidth="xs">
        <DialogTitle>选择接收人</DialogTitle>
        <DialogContent>
          <RadioGroup
            value={draftAudience}
            onChange={(event) => setDraftAudience(event.target.value as 'all' | 'selected')}
          >
            <FormControlLabel value="all" control={<Radio />} label="全体成员" />
            <p className="recipient-description">之后加入房间的成员也可以下载。</p>
            <FormControlLabel value="selected" control={<Radio />} label="指定成员" />
            <p className="recipient-description">仅你和选中的成员可以查看、下载。</p>
          </RadioGroup>
          {draftAudience === 'selected' && (
            <div className="recipient-members">
              {otherMembers.length ? (
                otherMembers.map((member) => (
                  <label className="recipient-member" key={member.id}>
                    <Checkbox
                      checked={draftRecipients.includes(member.id)}
                      onChange={(event) =>
                        setDraftRecipients((previous) =>
                          event.target.checked
                            ? [...previous, member.id]
                            : previous.filter((id) => id !== member.id),
                        )
                      }
                    />
                    <UserAvatar name={member.username} />
                    <span>{member.username}</span>
                  </label>
                ))
              ) : (
                <Alert severity="info">房间里暂时没有其他成员，请先分享配对码邀请伙伴加入。</Alert>
              )}
            </div>
          )}
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setPicker(false)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={draftAudience === 'selected' && draftRecipients.length === 0}
            onClick={() => {
              setAudience(draftAudience);
              setRecipients(draftRecipients);
              setPicker(false);
            }}
          >
            应用选择
          </Button>
        </DialogActions>
      </Dialog>
    </section>
  );
}
