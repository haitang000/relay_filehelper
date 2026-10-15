import { useState } from 'react';
import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, LinearProgress, Menu, MenuItem, Pagination, Tab, Tabs, TextField, Tooltip } from '@mui/material';
import { ArrowDownToLine, Clock3, Copy, Files, MoreHorizontal, Search, Trash2, Users } from 'lucide-react';
import { api, errorText, formatBytes, json, type FilePage, type SharedFile } from './api';
import { FileIcon, UserAvatar } from './components';

function remaining(expiresAt: number) {
  const hours = (expiresAt - Date.now()) / 3600000;
  return hours <= 0 ? '已过期' : hours < 1 ? `剩余 ${Math.ceil(hours * 60)} 分钟` : hours < 24 ? `剩余 ${Math.ceil(hours)} 小时` : `剩余 ${Math.ceil(hours / 24)} 天`;
}
const date = (value: number) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
type Props = { data: FilePage; tab: 'received' | 'sent'; setTab: (tab: 'received' | 'sent') => void; search: string; setSearch: (search: string) => void; page: number; setPage: (page: number) => void; loading: boolean; onChange: () => void; userId: string; error: string; receivedCount: number; sentCount: number; onShare: () => void };
export default function FileList({ data, tab, setTab, search, setSearch, page, setPage, loading, onChange, userId, error, receivedCount, sentCount, onShare }: Props) {
  const [deleting, setDeleting] = useState<SharedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [menu, setMenu] = useState<{anchor: HTMLElement; file: SharedFile} | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  async function remove() {
    if (!deleting) return;
    setBusy(true); setActionError('');
    try { await api(`/files/${deleting.id}`, json('DELETE')); setDeleting(null); onChange(); }
    catch (error) { setActionError(errorText(error)); } finally { setBusy(false); }
  }
  async function download(file: SharedFile) {
    setActionError(''); setDownloading(file.id);
    try {
      const path = `/api/files/${file.id}/download`;
      const check = await fetch(path, { method: 'HEAD' });
      if (!check.ok) { if (check.status === 401) window.dispatchEvent(new Event('session-expired')); throw new Error('文件已过期、已删除或登录已失效，请刷新后重试'); }
      const anchor = document.createElement('a');
      anchor.href = path; anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove();
    } catch (error) { setActionError(errorText(error)); } finally { setDownloading(null); }
  }
  return <section className="panel files-panel" aria-label="房间文件">
    <div className="file-section-title"><h2>文件<span className="count-pill">{data.total}</span></h2><span className="sync-note">每 5 秒自动同步</span></div>
    <div className="file-toolbar"><Tabs value={tab} onChange={(_event, value) => setTab(value)} aria-label="文件收发分类"><Tab value="received" label={<span className="tab-label">收到的文件 <i>{receivedCount}</i></span>} /><Tab value="sent" label={<span className="tab-label">我发送的 <i>{sentCount}</i></span>} /></Tabs><TextField className="file-search" placeholder="搜索文件" size="small" value={search} onChange={e => setSearch(e.target.value)} inputProps={{ 'aria-label': '搜索文件名' }} InputProps={{ startAdornment: <InputAdornment position="start"><Search size={17} /></InputAdornment> }} /></div>
    {(error || actionError) && <Alert severity="error" sx={{ m: 2 }} onClose={actionError ? () => setActionError('') : undefined}>{error || actionError}</Alert>}
    {loading && data.files.length > 0 && <LinearProgress aria-label="正在同步文件" />}
    {loading && data.files.length === 0 ? <div className="files-empty"><CircularProgress size={26} /><p>正在加载文件…</p></div> : data.files.length === 0 ? <div className="files-empty"><span className="empty-icon"><Files size={33} strokeWidth={1.4} /></span><h3>{search ? '没有找到匹配的文件' : tab === 'received' ? '还没有收到文件' : '还没有发送文件'}</h3><p>{search ? '换个关键词，或清空搜索再试试。' : tab === 'received' ? '分享房间配对码，邀请伙伴加入并向你发送文件。' : '选择文件和接收人，发送后就会显示在这里。'}</p>{search ? <Button onClick={() => setSearch('')}>清空搜索</Button> : tab === 'received' ? <Button startIcon={<Copy size={15} />} onClick={onShare}>复制配对码</Button> : null}</div>
    : <div className="file-table-wrap"><table className="file-table"><thead><tr><th scope="col">文件名称</th><th scope="col">{tab === 'sent' ? '接收人' : '发送者'}</th><th scope="col">发送时间</th><th scope="col">有效期</th><th scope="col" className="actions-heading">操作</th></tr></thead><tbody>{data.files.map(file => <tr key={file.id}><td className="file-name-cell"><div className="file-name-content"><FileIcon name={file.name} /><div><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)}</span></div></div></td><td className="file-sender">{tab === 'sent' ? <Tooltip title={file.audience === 'all' ? '包含之后加入房间的成员' : file.recipients.map(user => user.username).join('、')}><span className="audience-label"><Users size={15} />{file.audience === 'all' ? '全体成员' : `${file.recipients.length} 位成员`}</span></Tooltip> : <span className="sender-person"><UserAvatar name={file.senderName} size={26} /><span>{file.senderName}</span></span>}</td><td className="file-date"><time dateTime={new Date(file.createdAt).toISOString()}>{date(file.createdAt)}</time></td><td className="file-expiry"><Tooltip title={`到期：${new Date(file.expiresAt).toLocaleString('zh-CN')}`}><span className={`expiry-badge ${file.expiresAt - Date.now() < 3600000 ? 'soon' : ''}`}><Clock3 size={13} />{remaining(file.expiresAt)}</span></Tooltip></td><td className="file-actions"><div><Button size="small" aria-label={`下载 ${file.name}`} disabled={downloading===file.id} startIcon={downloading===file.id ? <CircularProgress size={15} /> : <ArrowDownToLine size={16} />} onClick={() => download(file)}>下载</Button>{file.senderId === userId && <Tooltip title="更多操作"><IconButton size="small" aria-label={`${file.name} 更多操作`} onClick={event => setMenu({anchor:event.currentTarget,file})}><MoreHorizontal size={19} /></IconButton></Tooltip>}</div></td></tr>)}</tbody></table></div>}
    <div className="files-footer"><span>共 {data.total} 个文件</span>{data.total > 50 ? <Pagination size="small" count={Math.ceil(data.total / 50)} page={page} onChange={(_event, value) => setPage(value)} /> : <span>到期后自动删除</span>}</div>
    <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}><MenuItem onClick={() => { if (menu) { setDeleting(menu.file); setActionError(''); } setMenu(null); }} sx={{color:'error.main'}}><Trash2 size={17} />删除文件</MenuItem></Menu>
    <Dialog open={!!deleting} onClose={busy ? undefined : () => setDeleting(null)} fullWidth maxWidth="xs"><DialogTitle>删除这个文件？</DialogTitle><DialogContent><p className="dialog-description">「{deleting?.name}」将从服务器删除，所有接收人都将无法下载。此操作无法撤销。</p>{actionError && <Alert severity="error">{actionError}</Alert>}</DialogContent><DialogActions><Button color="inherit" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button color="error" variant="contained" disabled={busy} onClick={remove}>{busy ? '删除中…' : '删除文件'}</Button></DialogActions></Dialog>
  </section>;
}
