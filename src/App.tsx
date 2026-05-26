import { Theme } from '@carbon/react';
import { TraceApp } from './components/TraceApp';
import './App.css';

export default function App() {
  return (
    <Theme theme="g100" style={{ height: '100%' }}>
      <TraceApp />
    </Theme>
  );
}
