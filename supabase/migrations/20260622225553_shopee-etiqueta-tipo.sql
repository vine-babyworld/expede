ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS etiqueta_tipo TEXT DEFAULT 'zpl';
