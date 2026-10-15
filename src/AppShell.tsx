import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Alert, Button, CircularProgress, Drawer, IconButton, Menu as MuiMenu, MenuItem, Snackbar, Tooltip } from '@mui/material';
import { ArrowLeft, ChevronDown, ChevronRight, FolderClosed, Hash, Home as HomeIcon, LayoutGrid, LogOut, Menu, Plus, RefreshCw, X } from 'lucide-react';
import { api, errorText, json, type Config, type Room, type User } from './api';
import { AuthScreen, Brand, RoomDialog, UserAvatar } from './components';
import { Home, RoomDirectory } from './RoomDirectory';
import { routeFromHash, routeHash, type AppRoute } from './navigation';

type RoomProps = { initialRoom: Room; user: User; config: Config; refreshRooms: () => Promise<void>; onBusy: (busy: boolean) => void; notify: (message: string) => void };

export default function AppShell({ RoomWorkspace }: { RoomWorkspace: ComponentType<RoomProps> }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [startupError, setStartupError] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [roomError, setRoomError] = useState('');
  const [route, setRoute] = useState<AppRoute>(() => routeFromHash(window.location.hash));
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [snack, setSnack] = useState('');
  const [notice, setNotice] = useState('');
  const currentUserId = useRef<string | null>(null);
  const navigation = useRef({ route, uploading });
  currentUserId.current = user?.id ?? null;
  navigation.current = { route, uploading };

  useEffect(() => {
    const changed = () => {
      const next = routeFromHash(window.location.hash);
      const current = navigation.current;
      if (current.uploading && routeHash(next) !== routeHash(current.route)) {
        window.history.replaceState(null, '', routeHash(current.route));
        setSnack('文件正在上传，请等待完成后再切换页面');
        return;
      }
      setRoute(next);
      setDrawer(false);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  function navigate(next: AppRoute) {
    if (uploading) { setSnack('文件正在上传，请等待完成后再切换页面'); return; }
    setRoute(next);
    setDrawer(false);
    const hash = routeHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([api<Config>('/config', { signal: controller.signal }), api<User>('/auth/me', { signal: controller.signal })]).then(([settings, account]) => {
      if (controller.signal.aborted) return;
      if (settings.status === 'fulfilled') setConfig(settings.value); else setStartupError('暂时无法连接服务器，请检查服务是否启动。');
      if (account.status === 'fulfilled') setUser(account.value);
      setInitializing(false);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const expired = () => { setUser(null); setRooms([]); setRoomsLoaded(false); setUploading(false); setNotice('登录已失效，请重新登录后继续'); };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  const refreshRooms = useCallback(async () => {
    if (!user) return;
    try {
      const next = await api<Room[]>('/rooms');
      if (currentUserId.current !== user.id) return;
      setRooms(next); setRoomError(''); setRoomsLoaded(true);
    } catch (error) { if (currentUserId.current === user.id) { setRoomError(errorText(error)); setRoomsLoaded(true); } }
  }, [user]);
  useEffect(() => { void refreshRooms(); }, [refreshRooms]);
  async function logout() {
    try { await api('/auth/logout', json('POST')); setUser(null); setRooms([]); setRoomsLoaded(false); setNotice(''); navigate({ page: 'home' }); }
    catch (error) { setSnack(errorText(error)); }
  }
  function roomDone(room: Room) {
    setRooms(previous => previous.some(item => item.id === room.id) ? previous.map(item => item.id === room.id ? room : item) : [...previous, room]);
    setRoomsLoaded(true); navigate({ page: 'room', roomId: room.id }); setDialog(null); setSnack('房间已准备好，开始分享吧');
  }

  if (initializing) return <div className="startup"><Brand /><CircularProgress size={26} /><p>正在准备你的分享空间…</p></div>;
  if (!config || startupError) return <div className="startup"><Brand /><Alert severity="error">{startupError || '配置加载失败'}</Alert><Button startIcon={<RefreshCw size={16} />} onClick={() => location.reload()}>重新连接</Button></div>;
  if (!user) return <AuthScreen config={config} notice={notice} onLogin={account => { setUser(account); setRoomsLoaded(false); setNotice(''); }} />;

  const selected = route.page === 'room' ? rooms.find(room => room.id === route.roomId) : undefined;
  const goHome = () => navigate({ page: 'home' });
  const goWorkspace = () => { navigate({ page: 'workspace' }); void refreshRooms(); };
  const openRoom = (room: Room) => navigate({ page: 'room', roomId: room.id });
  const create = () => setDialog('create');
  const join = () => setDialog('join');
  const sidebar = <div className="sidebar-content">
    <button className="brand-home" aria-label="返回首页" disabled={uploading} onClick={goHome}><Brand /></button>
    <div className="sidebar-intro">文件传输助手</div>
    <div className="sidebar-section-label">导航</div>
    <button className={`sidebar-overview ${route.page === 'home' ? 'active' : ''}`} disabled={uploading} aria-current={route.page === 'home' ? 'page' : undefined} onClick={goHome}><HomeIcon size={18} /><span>首页</span></button>
    <button className={`sidebar-overview ${route.page === 'workspace' ? 'active' : ''}`} disabled={uploading} aria-current={route.page === 'workspace' ? 'page' : undefined} onClick={goWorkspace}><LayoutGrid size={18} /><span>工作空间</span><span className="nav-count">{rooms.length.toString().padStart(2, '0')}</span></button>
    <div className="sidebar-section-label rooms-label">已加入的房间 <Tooltip title="创建房间"><span><IconButton size="small" aria-label="创建房间" disabled={uploading} onClick={create}><Plus size={15} /></IconButton></span></Tooltip></div>
    <nav aria-label="房间列表" className="room-nav">
      {rooms.map((room, index) => <button disabled={uploading} key={room.id} className={`room-nav-item ${selected?.id === room.id ? 'selected' : ''}`} aria-current={selected?.id === room.id ? 'page' : undefined} onClick={() => openRoom(room)}><span className={`room-letter tone-${index % 3}`}><Hash size={17} /></span><span>{room.name}</span>{selected?.id === room.id && <span className="selected-dot" />}</button>)}
      {rooms.length === 0 && <span className="sidebar-empty">你的房间将出现在这里</span>}
    </nav>
    <Button variant="outlined" color="inherit" className="sidebar-join" startIcon={<Plus size={16} />} disabled={uploading} onClick={join}>加入或连接新房间</Button>
    <div className="sidebar-bottom">
      <div className="sidebar-user"><UserAvatar name={user.username} size={35} /><div><strong>{user.username}</strong><span>个人账号</span></div><Tooltip title={uploading ? '请等待上传完成' : '退出登录'}><span><IconButton aria-label="退出登录" disabled={uploading} onClick={logout} size="small"><LogOut size={16} /></IconButton></span></Tooltip></div>
    </div>
  </div>;

  return <div className="app-shell">
    <aside className="desktop-sidebar">{sidebar}</aside>
    <Drawer open={drawer} onClose={() => setDrawer(false)} sx={{ '& .MuiDrawer-paper': { width: 250 } }}>{sidebar}</Drawer>
    <div className="app-main">
      <header className="topbar">
        <nav className="breadcrumb" aria-label="页面路径">
          <IconButton className="mobile-menu" aria-label="打开导航" onClick={() => setDrawer(true)}><Menu size={20} /></IconButton>
          <FolderClosed size={16} />
          <button disabled={uploading} onClick={goHome} aria-current={route.page === 'home' ? 'page' : undefined}>首页</button>
          {route.page !== 'home' && <><ChevronRight size={13} /><button disabled={uploading} onClick={goWorkspace} aria-current={route.page === 'workspace' ? 'page' : undefined}>工作空间</button></>}
          {route.page === 'room' && <><ChevronRight size={13} /><strong aria-current="page">{selected?.name ?? '房间'}</strong></>}
        </nav>
        <button className="account-trigger" aria-label="账号菜单" aria-haspopup="menu" aria-expanded={!!accountAnchor} disabled={uploading} onClick={event => setAccountAnchor(event.currentTarget)}><UserAvatar name={user.username} size={30} /><span>{user.username}</span><ChevronDown size={15} /></button>
      </header>
      <main className="page-content">
        {roomError && <Alert severity="error" sx={{ mb: 2 }} action={<Button size="small" onClick={() => void refreshRooms()}>重试</Button>}>{roomError}</Alert>}
        {route.page === 'home' ? <Home rooms={rooms} username={user.username} onOpen={openRoom} onWorkspace={goWorkspace} onCreate={create} onJoin={join} />
          : route.page === 'workspace' ? <RoomDirectory rooms={rooms} loading={!roomsLoaded} onOpen={openRoom} onCreate={create} onJoin={join} />
          : !roomsLoaded ? <div className="files-empty"><CircularProgress size={26} /><p>正在加载房间…</p></div>
          : selected ? <><Button className="room-back" color="inherit" startIcon={<ArrowLeft size={15} />} disabled={uploading} onClick={goWorkspace}>返回工作空间</Button><RoomWorkspace key={selected.id} initialRoom={selected} user={user} config={config} refreshRooms={refreshRooms} onBusy={setUploading} notify={setSnack} /></>
          : <div className="directory-empty panel"><h1>无法打开这个房间</h1><p>房间不存在，或当前账号尚未加入。</p><Button variant="contained" onClick={goWorkspace}>返回工作空间</Button></div>}
      </main>
    </div>
    <MuiMenu anchorEl={accountAnchor} open={!!accountAnchor} onClose={() => setAccountAnchor(null)}><MenuItem onClick={() => { setAccountAnchor(null); goHome(); }}><HomeIcon size={17} />首页</MenuItem><MenuItem onClick={() => { setAccountAnchor(null); goWorkspace(); }}><LayoutGrid size={17} />工作空间</MenuItem><MenuItem disabled={uploading} onClick={() => { setAccountAnchor(null); void logout(); }}><LogOut size={17} />退出登录</MenuItem></MuiMenu>
    {dialog && <RoomDialog key={dialog} mode={dialog} onClose={() => setDialog(null)} onDone={roomDone} />}
    <Snackbar open={!!snack} autoHideDuration={4500} onClose={() => setSnack('')} message={snack} action={<IconButton size="small" color="inherit" aria-label="关闭提示" onClick={() => setSnack('')}><X size={16} /></IconButton>} />
  </div>;
}
