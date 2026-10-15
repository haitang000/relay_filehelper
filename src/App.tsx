import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress, Tooltip } from '@mui/material';
import { Clock3, Copy, HardDrive, Settings2, Users } from 'lucide-react';
import { api, errorText, formatBytes, ttlLabel, type Config, type FilePage, type Member, type Room, type User } from './api';
import { SettingsDialog, UserAvatar } from './components';
import AppShell from './AppShell';
import UploadPanel from './UploadPanel';
import FileList from './FileList';

const emptyFiles: FilePage = { files: [], total: 0, page: 1, pageSize: 50 };
type RoomDetail = Room & { receivedCount: number; sentCount: number };
function Workspace({ initialRoom, user, config, refreshRooms, onBusy, notify }: { initialRoom: Room; user: User; config: Config; refreshRooms: () => Promise<void>; onBusy: (busy: boolean) => void; notify: (message: string) => void }) {
  const [room, setRoom] = useState<RoomDetail>({ ...initialRoom, receivedCount: 0, sentCount: 0 });
  const [members, setMembers] = useState<Member[]>([]);
  const [data, setData] = useState<FilePage>(emptyFiles);
  const [tab, setTab] = useState<'received' | 'sent'>('received');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [version, setVersion] = useState(0);
  const roomId = initialRoom.id;
  const refresh = useCallback(() => setVersion(previous => previous + 1), []);
  useEffect(() => { const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function load() {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const options = { signal: controller.signal };
        const [nextRoom, nextMembers, nextFiles] = await Promise.all([
          api<RoomDetail>(`/rooms/${roomId}`, options), api<Member[]>(`/rooms/${roomId}/members`, options),
          api<FilePage>(`/rooms/${roomId}/files?${new URLSearchParams({ tab, search: debouncedSearch, page: String(page) })}`, options),
        ]);
        if (!controller.signal.aborted) { setRoom(nextRoom); setMembers(nextMembers); setData(nextFiles); setError(''); if (page > 1 && nextFiles.files.length === 0) setPage(Math.max(1, Math.ceil(nextFiles.total / 50))); }
      } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
      finally { inFlight = false; if (!controller.signal.aborted) setLoading(false); }
    }
    setLoading(true);
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    const show = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', show);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', show); };
  }, [roomId, tab, debouncedSearch, page, version]);
  async function copy() {
    try { await navigator.clipboard.writeText(room.code); notify('配对码已复制，分享给伙伴即可加入'); }
    catch { notify(`配对码：${room.code}（当前浏览器不支持自动复制，可手动选择）`); }
  }
  async function settingsChanged() { await refreshRooms(); refresh(); }
  return <>
    <section className="room-header">
      <div className="room-heading"><div><span className="page-overline">共享房间</span><div className="room-title-line"><h1>{room.name}</h1>{room.isAdmin && <Chip size="small" label="管理员" variant="outlined" />}</div></div>
        <div className="room-heading-actions"><Button color="inherit" variant="outlined" startIcon={<Users size={17} />} onClick={() => setShowMembers(true)}>成员 {room.memberCount}</Button>{room.isAdmin && <Tooltip title="有效期与配对码"><IconButton aria-label="房间设置" onClick={() => setSettings(true)}><Settings2 size={20} /></IconButton></Tooltip>}</div>
      </div>
      <div className="room-context">
        <button className="pairing-button" onClick={copy} aria-label="复制房间配对码"><span>配对码</span><code>{room.code.slice(0, 4)} {room.code.slice(4)}</code><Copy size={15} /></button>
        <span className="room-context-item"><Clock3 size={15} />新文件有效期 {ttlLabel(room.ttlHours)}</span>
      </div>
    </section>
    <div className="workspace-grid">
      <div className="workspace-files"><FileList data={data} tab={tab} setTab={value => { setTab(value); setPage(1); setData(emptyFiles); }} search={search} setSearch={setSearch} page={page} setPage={setPage} loading={loading} onChange={() => { refresh(); void refreshRooms(); }} userId={user.id} error={error} receivedCount={room.receivedCount} sentCount={room.sentCount} onShare={copy} /></div>
      <div className="workspace-compose"><UploadPanel room={room} members={members} userId={user.id} config={config} onUploaded={() => { setTab('sent'); setPage(1); refresh(); void refreshRooms(); }} onBusy={onBusy} />
        <section className="storage-summary"><div><HardDrive size={17} /><strong>房间存储</strong><span>{formatBytes(room.usedBytes)} / {formatBytes(room.quotaBytes)}</span></div><LinearProgress variant="determinate" aria-label="房间存储使用量" value={Math.min(100, room.usedBytes / room.quotaBytes * 100)} /><p>{room.usedBytes >= room.quotaBytes ? '空间已满，请删除自己发送的文件。' : '文件到期后自动删除，释放存储空间。'}</p></section>
      </div>
    </div>
    {settings && <SettingsDialog room={room} onClose={() => setSettings(false)} onChange={settingsChanged} />}
    <Dialog open={showMembers} onClose={() => setShowMembers(false)} fullWidth maxWidth="xs"><DialogTitle>房间成员<span className="dialog-count">{members.length} 人</span></DialogTitle><DialogContent><div className="member-list">{members.map(member => <div className="member-line" key={member.id}><UserAvatar name={member.username} size={38} /><div><strong>{member.username}{member.id === user.id ? '（你）' : ''}</strong><span>{new Date(member.joinedAt).toLocaleDateString('zh-CN')} 加入</span></div><span className="member-role">{member.id === room.adminId ? '管理员' : '成员'}</span></div>)}</div></DialogContent><DialogActions><Button onClick={() => setShowMembers(false)}>完成</Button></DialogActions></Dialog>
  </>;
}

export default function App() {
  return <AppShell RoomWorkspace={Workspace} />;
}
