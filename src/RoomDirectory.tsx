import { useState } from 'react';
import { Button, Chip, CircularProgress, InputAdornment, TextField } from '@mui/material';
import { ArrowRight, Clock3, FolderClosed, Hash, Plus, Search, ShieldCheck, Users } from 'lucide-react';
import { ttlLabel, type Room } from './api';

type Actions = { onCreate: () => void; onJoin: () => void };
function RoomCard({ room, onOpen }: { room: Room; onOpen: (room: Room) => void }) {
  return <article className="room-card">
    <div className="room-card-top"><span className="room-card-icon"><FolderClosed size={24} strokeWidth={1.6} /></span><Chip size="small" label={room.isAdmin ? '管理员' : '成员'} variant="outlined" /></div>
    <h2>{room.name}</h2>
    <div className="room-card-meta"><span><Users size={15} />{room.memberCount} 位成员</span><span><Clock3 size={15} />{ttlLabel(room.ttlHours)}有效期</span></div>
    <Button variant="text" fullWidth endIcon={<ArrowRight size={17} />} aria-label={`进入房间 ${room.name}`} onClick={() => onOpen(room)}>打开房间</Button>
  </article>;
}
export function Home({ rooms, username, onOpen, onWorkspace, onCreate, onJoin }: Actions & { rooms: Room[]; username: string; onOpen: (room: Room) => void; onWorkspace: () => void }) {
  return <div className="home-page">
    <header className="home-heading"><span className="page-overline">首页</span><h1>你好，{username}。</h1><p>创建一个房间，或回到你的分享空间。</p></header>
    <section className="home-actions" aria-label="快速操作">
      <button className="home-action primary-action" onClick={onCreate}><span className="home-action-icon"><Plus size={25} /></span><span><strong>创建房间</strong><small>建立一个新的文件分享空间</small></span><ArrowRight size={20} /></button>
      <button className="home-action" onClick={onJoin}><span className="home-action-icon"><Hash size={25} /></span><span><strong>加入房间</strong><small>输入 8 位配对码，与伙伴连接</small></span><ArrowRight size={20} /></button>
    </section>
    <section className="home-rooms"><div className="subsection-heading"><h2>我的房间<span>{rooms.length}</span></h2><Button onClick={onWorkspace} endIcon={<ArrowRight size={16} />}>查看全部</Button></div>
      {rooms.length ? <div className="room-card-grid">{rooms.slice(-3).reverse().map(room => <RoomCard key={room.id} room={room} onOpen={onOpen} />)}</div> : <div className="directory-empty"><FolderClosed size={34} strokeWidth={1.4} /><h2>你的第一个房间，从这里开始</h2><p>创建房间后，把配对码分享给伙伴，即可收发文件。</p><Button onClick={onCreate}>创建第一个房间</Button></div>}
    </section>
    <div className="home-note"><ShieldCheck size={19} /><p>定向文件仅对你和指定成员可见。文件到期后，服务器会自动删除。</p></div>
  </div>;
}
export function RoomDirectory({ rooms, loading, onOpen, onCreate, onJoin }: Actions & { rooms: Room[]; loading: boolean; onOpen: (room: Room) => void }) {
  const [search, setSearch] = useState('');
  const filtered = rooms.filter(room => room.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="room-directory">
    <div className="directory-heading"><div><span className="page-overline">工作空间</span><h1>我的房间</h1><p>你已加入 {rooms.length} 个房间。</p></div><div className="directory-actions"><Button variant="outlined" color="inherit" startIcon={<Hash size={17} />} onClick={onJoin}>加入房间</Button><Button variant="contained" startIcon={<Plus size={17} />} onClick={onCreate}>创建房间</Button></div></div>
    {rooms.length > 0 && <TextField className="room-search" placeholder="搜索房间名称" size="small" value={search} onChange={event => setSearch(event.target.value)} inputProps={{ 'aria-label': '搜索房间名称' }} InputProps={{ startAdornment: <InputAdornment position="start"><Search size={18} /></InputAdornment> }} />}
    {loading ? <div className="files-empty"><CircularProgress size={26} /><p>正在加载房间…</p></div> : filtered.length ? <div className="room-card-grid">{filtered.map(room => <RoomCard key={room.id} room={room} onOpen={onOpen} />)}</div> : <div className="directory-empty"><FolderClosed size={34} strokeWidth={1.4} /><h2>{search ? '没有找到匹配的房间' : '还没有加入房间'}</h2><p>{search ? '换一个名称，或清空搜索再试试。' : '创建一个房间，或输入伙伴分享的配对码。'}</p><Button variant={search ? 'text' : 'contained'} onClick={search ? () => setSearch('') : onCreate}>{search ? '清空搜索' : '创建房间'}</Button></div>}
  </section>;
}
