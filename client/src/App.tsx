import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { AdminLayout, RetailerLayout } from './layout';
import { Spinner } from './ui';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import RetailerHome from './pages/retailer/Home';
import Catalogue from './pages/retailer/Catalogue';
import Cart from './pages/retailer/Cart';
import MyOrders from './pages/retailer/MyOrders';
import OrderDetail from './pages/OrderDetail';
import AdminDashboard from './pages/admin/Dashboard';
import AdminOrders from './pages/admin/Orders';
import Inventory from './pages/admin/Inventory';
import Products from './pages/admin/Products';
import ImportPage from './pages/admin/Import';
import Retailers from './pages/admin/Retailers';
import Reports from './pages/admin/Reports';
import Assistant from './pages/admin/Assistant';
import SettingsPage from './pages/admin/Settings';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  if (user.mustChangePassword) return <ChangePassword forced />;

  if (user.role === 'admin') {
    return (
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/orders" element={<AdminOrders />} />
          <Route path="/admin/orders/:id" element={<OrderDetail admin />} />
          <Route path="/admin/inventory" element={<Inventory />} />
          <Route path="/admin/products" element={<Products />} />
          <Route path="/admin/import" element={<ImportPage />} />
          <Route path="/admin/retailers" element={<Retailers />} />
          <Route path="/admin/reports" element={<Reports />} />
          <Route path="/admin/assistant" element={<Assistant />} />
          <Route path="/admin/settings" element={<SettingsPage />} />
          <Route path="/account/password" element={<ChangePassword />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<RetailerLayout />}>
        <Route path="/" element={<RetailerHome />} />
        <Route path="/catalogue" element={<Catalogue />} />
        <Route path="/cart" element={<Cart />} />
        <Route path="/orders" element={<MyOrders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/account/password" element={<ChangePassword />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
