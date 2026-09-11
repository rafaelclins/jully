# JULLY

JULLY é um produto-base reutilizável para pequenos restaurantes: sistema de pedidos por QR Code com suporte multi-restaurante (multi-tenant).

> **Status:** fase de setup inicial. Nenhuma funcionalidade de negócio foi implementada ainda.

## Stack

- [Next.js](https://nextjs.org) (App Router)
- [TypeScript](https://www.typescriptlang.org)
- [Tailwind CSS](https://tailwindcss.com)
- [Prisma](https://www.prisma.io) (ORM futuro) + PostgreSQL
- [Zod](https://zod.dev) (validação)
- Git/GitHub

## Instalação

```bash
npm install
```

Copie o arquivo de exemplo de ambiente:

```bash
cp .env.example .env
```

Preencha `DATABASE_URL` com a conexão do PostgreSQL no `.env`.

> O banco de dados será conectado apenas em uma etapa futura.

## Ambiente local

```bash
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000).

## Scripts

| Comando        | Descrição                      |
| -------------- | ------------------------------ |
| `npm run dev`  | Inicia o servidor de desenvolvimento |
| `npm run build`| Gera a build de produção       |
| `npm run start`| Inicia a build de produção     |
| `npm run lint` | Executa o ESLint               |

## Estrutura

```
Jully/
├── docs/          # arquitetura, produto, decisões e testes
├── src/
│   ├── app/       # rotas do Next.js (App Router)
│   ├── components/
│   ├── features/
│   ├── lib/
│   ├── services/
│   ├── types/
│   └── config/
├── prisma/        # schema, migrations e seed
├── public/        # imagens e QR codes
├── tests/         # unit, integration e e2e
└── scripts/
```