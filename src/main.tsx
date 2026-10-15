import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { createTheme, ThemeProvider, CssBaseline, useMediaQuery } from '@mui/material';
import App from './App';
import './styles.css';
function ThemedApp() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const theme = useMemo(() => createTheme({
    palette: { primary: { main: '#0066d6' }, background: { default: '#f5f5f7', paper: '#fff' }, text: { primary: '#1d1d1f', secondary: '#67676e' }, divider: '#e5e5e9', success: { main: '#227347' } },
    typography: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', fontSize: 14, button: { textTransform: 'none', fontWeight: 600, fontSize: '0.875rem' }, body2: { lineHeight: 1.6 }, h4: { fontWeight: 700, letterSpacing: '-.025em' } },
    shape: { borderRadius: 12 },
    components: {
      MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 10, minHeight: 44, padding: '9px 16px', lineHeight: 1.4 }, outlined: { borderColor: '#d5d5dc', background: '#fff' } } },
      MuiIconButton: { styleOverrides: { root: { minWidth: 40, minHeight: 40 } } },
      MuiOutlinedInput: { styleOverrides: { root: { background: '#fff', fontSize: 15, borderRadius: 10 }, notchedOutline: { borderColor: '#cfcfd7' } } },
      MuiDialog: { defaultProps: { transitionDuration: reducedMotion ? 0 : 180 }, styleOverrides: { paper: { borderRadius: 22, padding: 0, backgroundImage: 'none', boxShadow: '0 24px 80px #1d1d1f24' } } },
      MuiDialogTitle: { styleOverrides: { root: { fontWeight: 650, fontSize: 21, padding: '24px 24px 16px' } } },
      MuiDialogActions: { styleOverrides: { root: { padding: '16px 24px 24px', gap: 8 } } },
      MuiDrawer: { defaultProps: { transitionDuration: reducedMotion ? 0 : 220 } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, minHeight: 44, minWidth: 120 } } },
      MuiChip: { styleOverrides: { root: { fontSize: 12, fontWeight: 500 } } },
      MuiMenu: { styleOverrides: { paper: { borderRadius: 13, border: '1px solid #e5e5e9', boxShadow: '0 12px 40px #1d1d1f18' } } },
    },
  }), [reducedMotion]);
  return <ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ThemedApp /></React.StrictMode>);
