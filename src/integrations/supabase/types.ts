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
      bling_connections: {
        Row: {
          access_expires_at: string | null
          access_token: string | null
          bling_account_id: string | null
          bling_account_name: string | null
          created_at: string
          id: string
          last_error: string | null
          last_refresh_at: string | null
          refresh_expires_at: string | null
          refresh_token: string | null
          scope: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_expires_at?: string | null
          access_token?: string | null
          bling_account_id?: string | null
          bling_account_name?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          last_refresh_at?: string | null
          refresh_expires_at?: string | null
          refresh_token?: string | null
          scope?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_expires_at?: string | null
          access_token?: string | null
          bling_account_id?: string | null
          bling_account_name?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          last_refresh_at?: string | null
          refresh_expires_at?: string | null
          refresh_token?: string | null
          scope?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bling_connections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
      oauth_states: {
        Row: {
          created_at: string
          state: string
          used: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          state: string
          used?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          state?: string
          used?: boolean
          user_id?: string
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
          altura: number | null
          ativo: boolean
          bipavel: boolean
          bling_connection_id: string
          bling_parent_id: number | null
          bling_product_id: number
          created_at: string
          detail_synced_at: string | null
          estoque: number | null
          gtin: string | null
          id: string
          imagem_url: string | null
          largura: number | null
          nome: string
          peso_bruto: number | null
          peso_liquido: number | null
          profundidade: number | null
          raw_data: Json | null
          sku: string
          synced_at: string
          tipo: string
          updated_at: string
        }
        Insert: {
          altura?: number | null
          ativo?: boolean
          bipavel?: boolean
          bling_connection_id: string
          bling_parent_id?: number | null
          bling_product_id: number
          created_at?: string
          detail_synced_at?: string | null
          estoque?: number | null
          gtin?: string | null
          id?: string
          imagem_url?: string | null
          largura?: number | null
          nome: string
          peso_bruto?: number | null
          peso_liquido?: number | null
          profundidade?: number | null
          raw_data?: Json | null
          sku: string
          synced_at?: string
          tipo?: string
          updated_at?: string
        }
        Update: {
          altura?: number | null
          ativo?: boolean
          bipavel?: boolean
          bling_connection_id?: string
          bling_parent_id?: number | null
          bling_product_id?: number
          created_at?: string
          detail_synced_at?: string | null
          estoque?: number | null
          gtin?: string | null
          id?: string
          imagem_url?: string | null
          largura?: number | null
          nome?: string
          peso_bruto?: number | null
          peso_liquido?: number | null
          profundidade?: number | null
          raw_data?: Json | null
          sku?: string
          synced_at?: string
          tipo?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "produtos_bling_connection_id_fkey"
            columns: ["bling_connection_id"]
            isOneToOne: false
            referencedRelation: "bling_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "produtos_bling_connection_id_fkey"
            columns: ["bling_connection_id"]
            isOneToOne: false
            referencedRelation: "bling_connections_status"
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
      sync_jobs: {
        Row: {
          bling_connection_id: string
          erros: Json
          fase: string
          finalizado_em: string | null
          id: string
          iniciado_em: string
          iniciado_por: string | null
          pagina_atual: number
          proxima_execucao_em: string | null
          status: string
          tipo: string
          total_erros: number
          total_paginas: number | null
          total_processados: number
          ultima_execucao_em: string | null
        }
        Insert: {
          bling_connection_id: string
          erros?: Json
          fase?: string
          finalizado_em?: string | null
          id?: string
          iniciado_em?: string
          iniciado_por?: string | null
          pagina_atual?: number
          proxima_execucao_em?: string | null
          status?: string
          tipo?: string
          total_erros?: number
          total_paginas?: number | null
          total_processados?: number
          ultima_execucao_em?: string | null
        }
        Update: {
          bling_connection_id?: string
          erros?: Json
          fase?: string
          finalizado_em?: string | null
          id?: string
          iniciado_em?: string
          iniciado_por?: string | null
          pagina_atual?: number
          proxima_execucao_em?: string | null
          status?: string
          tipo?: string
          total_erros?: number
          total_paginas?: number | null
          total_processados?: number
          ultima_execucao_em?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_jobs_bling_connection_id_fkey"
            columns: ["bling_connection_id"]
            isOneToOne: false
            referencedRelation: "bling_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_jobs_bling_connection_id_fkey"
            columns: ["bling_connection_id"]
            isOneToOne: false
            referencedRelation: "bling_connections_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_jobs_iniciado_por_fkey"
            columns: ["iniciado_por"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
      bling_connections_status: {
        Row: {
          access_expires_at: string | null
          bling_account_id: string | null
          bling_account_name: string | null
          created_at: string | null
          id: string | null
          last_error: string | null
          last_refresh_at: string | null
          refresh_expires_at: string | null
          scope: string | null
          status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          access_expires_at?: string | null
          bling_account_id?: string | null
          bling_account_name?: string | null
          created_at?: string | null
          id?: string | null
          last_error?: string | null
          last_refresh_at?: string | null
          refresh_expires_at?: string | null
          scope?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          access_expires_at?: string | null
          bling_account_id?: string | null
          bling_account_name?: string | null
          created_at?: string | null
          id?: string | null
          last_error?: string | null
          last_refresh_at?: string | null
          refresh_expires_at?: string | null
          scope?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bling_connections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      cleanup_oauth_states: { Args: never; Returns: undefined }
      current_empresa_id: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
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
