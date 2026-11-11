import { Route, Routes } from 'react-router-dom';
import { BindingPage } from './pages/BindingPage';
import { ComparePage } from './pages/ComparePage';
import { HomePage, NotFoundPage } from './pages/HomePage';
import { InsurerResponsePage } from './pages/InsurerResponsePage';
import { PaymentPage } from './pages/PaymentPage';
import { StartRequestPage } from './pages/StartRequestPage';

/**
 * Routes. Emailed links from WorkHub24 point at these paths with ?req=<Request No>:
 *   T-01 Insurer response link  -> /insurer/respond?req=MIG-2026-0148
 *   T-02 Packages ready         -> /finance/compare?req=...
 *   T-04 Binding link           -> /insurer/binding?req=...
 *   T-06 Payment link           -> /insurer/payment?req=...
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/start" element={<StartRequestPage />} />
      <Route path="/insurer/respond" element={<InsurerResponsePage />} />
      <Route path="/finance/compare" element={<ComparePage />} />
      <Route path="/insurer/binding" element={<BindingPage />} />
      <Route path="/insurer/payment" element={<PaymentPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
