"use client";

import { createAuthClient } from "better-auth/react";

// Cliente de autenticacao usado em componentes client-side (login/logout).
// Aponta para o handler montado em /api/auth/[...all].
export const authClient = createAuthClient();