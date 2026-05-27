export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bipagens: {
        Row: {
          codigo_bipado: string
          created_at: string
          id: string
          pedido_item_id: string | null
          resultado: string
          user_id: string | null
          usuario: string | null
        }
        Insert: {
          codigo_bipado: string
          created_at?: string
          id?: string
          pedido_item_id?: string | null
          resultado: string
          user_id?: string | null
          usuario?: string | null
        }
        Update: {
          codigo_bipado?: string
          created_at?: string
          id?: string
          pedido_item_id?: string | null
          resultado?: string
          user_id?: string | null
          usuario?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bipagens_pedido_item_id_fkey"
            columns: ["pedido_item_id"]
            isOneToOne: false
            referencedRelation: "pedido_itens"
            referencedColumns: ["id"]
          },
        ]
      }
      canais: {
        Row: {
          cor: string | null
          icone: string | null
          id: string
          nome: string
          slug: string
        }
        Insert: {
          cor?: string | null
          icone?: string | null
          id?: string
          nome: string
          slug: string
        }
        Update: {
          cor?: string | null
          icone?: string | null
          id?: string
          nome?: string
          slug?: string
        }
        Relationships: []
      }
      empresas: {
        Row: {
          ativa: boolean
          bling_token: string | null
          cnpj: string | null
          created_at: string
          id: string
          nome: string
        }
        Insert: {
          ativa?: boolean
          bling_token?: string | null
          cnpj?: string | null
          created_at?: string
          id?: string
          nome: string
        }
        Update: {
          ativa?: boolean
          bling_token?: string | null
          cnpj?: string | null
          created_at?: string
          id?: string
          nome?: string
        }
        Relationships: []
      }
      pedido_itens: {
        Row: {
          id: string
          pedido_id: string | null
          produto_id: string | null
          quantidade: number
          quantidade_bipada: number
          valor_unitario: number | null
        }
        Insert: {
          id?: string
          pedido_id?: string | null
          produto_id?: string | null
          quantidade?: number
          quantidade_bipada?: number
          valor_unitario?: number | null
        }
        Update: {
          id?: string
          pedido_id?: string | null
          produto_id?: string | null
          quantidade?: number
          quantidade_bipada?: number
          valor_unitario?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pedido_itens_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_itens_produto_id_fkey"
            columns: ["produto_id"]
            isOneToOne: false
            referencedRelation: "produtos"
            referencedColumns: ["id"]
          },
        ]
      }
      pedidos: {
        Row: {
          anotacoes: string | null
          bloco_separacao: string | null
          canal_id: string | null
          cidade_cliente: string | null
          created_at: string
          data_max_postagem: string | null
          data_pedido: string | null
          empresa_id: string | null
          estado_cliente: string | null
          id: string
          metodo_envio: string | null
          nome_cliente: string | null
          numero_pedido: string
          status: string
        }
        Insert: {
          anotacoes?: string | null
          bloco_separacao?: string | null
          canal_id?: string | null
          cidade_cliente?: string | null
          created_at?: string
          data_max_postagem?: string | null
          data_pedido?: string | null
          empresa_id?: string | null
          estado_cliente?: string | null
          id?: string
          metodo_envio?: string | null
          nome_cliente?: string | null
          numero_pedido: string
          status?: string
        }
        Update: {
          anotacoes?: string | null
          bloco_separacao?: string | null
          canal_id?: string | null
          cidade_cliente?: string | null
          created_at?: string
          data_max_postagem?: string | null
          data_pedido?: string | null
          empresa_id?: string | null
          estado_cliente?: string | null
          id?: string
          metodo_envio?: string | null
          nome_cliente?: string | null
          numero_pedido?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pedidos_canal_id_fkey"
            columns: ["canal_id"]
            isOneToOne: false
            referencedRelation: "canais"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      produtos: {
        Row: {
          bling_product_id: string | null
          created_at: string
          ean_principal: string | null
          eans_alternativos: string[]
          empresa_id: string | null
          foto_url: string | null
          id: string
          localizacao: string | null
          nome: string
          sku: string
        }
        Insert: {
          bling_product_id?: string | null
          created_at?: string
          ean_principal?: string | null
          eans_alternativos?: string[]
          empresa_id?: string | null
          foto_url?: string | null
          id?: string
          localizacao?: string | null
          nome: string
          sku: string
        }
        Update: {
          bling_product_id?: string | null
          created_at?: string
          ean_principal?: string | null
          eans_alternativos?: string[]
          empresa_id?: string | null
          foto_url?: string | null
          id?: string
          localizacao?: string | null
          nome?: string
          sku?: string
        }
        Relationships: [
          {
            foreignKeyName: "produtos_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          ativo: boolean
          created_at: string
          email: string
          empresa_id: string | null
          id: string
          nome: string
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          created_at?: string
          email: string
          empresa_id?: string | null
          id: string
          nome: string
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          created_at?: string
          email?: string
          empresa_id?: string | null
          id?: string
          nome?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_empresa_id: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "operador"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operador"],
    },
  },
} as const
