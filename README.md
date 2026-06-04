# sn-to-java-react

A VS Code extension that converts a ServiceNow scoped application into a Spring Boot multi-module Maven project plus a Vite/React/TypeScript frontend, using a **6-stage agentic pipeline**. All LLM calls route through **GitHub Copilot** via the `vscode.lm` API — no Claude API key, no direct provider calls, fully compliant with Copilot-only org policy.

## The pipeline

| Stage | Agent | Output | LLM? |
|------:|:------|:-------|:----:|
| 1 | **Extractor** | Pulls every artifact in the scoped app (Tables, Business Rules, Script Includes, Client Scripts, Scripted REST, UI Pages, ACLs) via the ServiceNow Table API. | no |
| 2 | **Parser** | Runs `@babel/parser` over every GlideScript and emits structured `ScriptPatterns`: GlideRecord usage (table, queries, reads, writes, operations), `gs.*` calls, `current.*` access, Script-Include references, `setAbortAction`, JSON ops. | no |
| 3 | **Mapper** | Produces a `SemanticPlan`: which SN artifact lands in which Maven module and which Java class kind (entity/repository/dto/service/utility/controller/securityRule). Deterministic — routing decisions are policy, not LLM output. | no |
| 4 | **Generator** | Per-artifact code generation. Each generator receives Stage 2's parsed patterns alongside the raw script, so prompts are *grounded* — Copilot is asked to translate, not reverse-engineer. Returns `GeneratedFile[]` in memory. | yes (Copilot) |
| 5 | **Validator** | Writes Stage 4 files to disk, generates JUnit 5 stubs (one per Java class, kind-aware), spawns `mvn compile` and parses errors/warnings line-by-line. Optional CheckStyle and SpotBugs. | no |
| 6 | **Assembler** | Writes the structural envelope: parent + module POMs, `application.yml` + **dev (H2) / prod (SQL Server)** profiles, `Application.java`, Vite/React project files. Aggregates ACLs into a single `SecurityFilterChain`. Generates the Liquibase changelog tree (master + per-table changesets). Writes `CONVERSION_REPORT.md` summarising every stage. | no |

Each stage takes the previous stage's typed output and returns its own — handoffs are in `src/pipeline/types.ts`.

## Project layout

```
src/
├── extension.ts          # entry; registers commands and chat participant
├── chat.ts               # @servicenow participant: /convert /explain /preview /validate
├── pipeline/
│   ├── orchestrator.ts   # strings all 6 stages together
│   ├── types.ts          # type contracts for every stage handoff
│   ├── stage1Extractor.ts
│   ├── stage2Parser.ts
│   ├── stage3Mapper.ts
│   ├── stage4Generator.ts
│   ├── stage5Validator.ts
│   └── stage6Assembler.ts
├── parser/
│   └── glideScriptParser.ts   # @babel/parser + traverse, extracts ScriptPatterns
├── generators/                 # called by Stage 4
│   ├── entityGenerator.ts      # JPA entity + repository + DTO
│   ├── serviceGenerator.ts     # Business Rule → @Service (patterns-grounded prompt)
│   ├── controllerGenerator.ts  # CRUD (template) + Scripted REST (LLM)
│   ├── scriptIncludeGenerator.ts
│   └── reactGenerator.ts
├── validators/
│   ├── mavenRunner.ts          # spawns mvn, parses javac/checkstyle/spotbugs lines
│   └── junitStubber.ts         # JUnit 5 stub per generated class, kind-aware
├── assemblers/
│   ├── projectAssembler.ts     # POMs, application.yml, main class, React skeleton
│   ├── liquibaseGenerator.ts   # master changelog + per-table createTable changesets
│   └── securityConfigAssembler.ts  # ACLs → aggregated SecurityFilterChain
├── llm/copilot.ts              # the ONE chokepoint: vscode.lm.selectChatModels
├── servicenow/                 # Table API client + types
└── util/                       # naming helpers, SecretStorage credentials
```

## Database posture (H2 dev → SQL Server prod)

Generated backends default to the **`dev`** profile: embedded **H2** on disk (`backend/data/`, gitignored) with `MODE=MSSQLServer` so SQL types and Liquibase changesets stay closer to production **SQL Server**. H2 console is at `/h2-console` (you may need to permit it in `SecurityConfig` if Spring Security blocks it).

**Local dev (default):**

```bash
cd backend && mvn -pl web spring-boot:run
# optional: SPRING_PROFILES_ACTIVE=dev (already the default)
```

**SQL Server (prod profile):**

```bash
export SPRING_PROFILES_ACTIVE=prod
export DATASOURCE_URL="jdbc:sqlserver://localhost:1433;databaseName=myscope;encrypt=true;trustServerCertificate=true"
export DB_USER=app
export DB_PASSWORD=secret
cd backend && mvn -pl web spring-boot:run
```

`web/pom.xml` includes both `h2` and `mssql-jdbc` (versions from the Spring Boot BOM). Liquibase changelogs stay database-agnostic; re-run the same migrations when you switch profiles.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `snConvert.instanceUrl` | `""` | ServiceNow base URL |
| `snConvert.username` | `""` | SN username (password in SecretStorage via `ServiceNow: Connect`) |
| `snConvert.javaPackage` | `com.acme.converted` | Base Java package (scope appended automatically) |
| `snConvert.jdkVersion` | `21` | Target JDK (17 or 21) |
| `snConvert.springBootVersion` | `3.3.4` | Spring Boot version |
| `snConvert.copilotModel` | `gpt-4o` | Preferred Copilot model family |
| `snConvert.outputDirectory` | `""` | Where to write generated projects (defaults to current workspace) |
| `snConvert.runMavenValidation` | `true` | Run `mvn compile` in Stage 5 |
| `snConvert.runCheckstyle` | `false` | Add `maven-checkstyle-plugin` and run it in Stage 5 |
| `snConvert.runSpotbugs` | `false` | Add `spotbugs-maven-plugin` and run it in Stage 5 |

## Usage

1. `ServiceNow: Connect to Instance` — store the URL + creds (password to SecretStorage).
2. `ServiceNow: List Scoped Applications` — copy the sys_id you want.
3. `ServiceNow: Scan UI Artifacts and Generate TODO` — creates a deterministic migration checklist from discovered UI Pages, Client Scripts, REST endpoints, and ACL follow-ups (existing checked items are preserved on re-scan).
4. `ServiceNow: Open Pipeline Progress View` — optional dashboard for real-time stage status + logs.
5. `ServiceNow: Run Conversion Pipeline` — paste the sys_id (or scope name like `x_acme_orders`); a notification streams Stage 1 → Stage 6 progress and the progress view updates in parallel.
6. Open `CONVERSION_REPORT.md` in the generated project root — every error, warning, and TODO is listed by stage.

The `@servicenow` chat participant supports `/convert`, `/explain`, `/preview`, `/validate` for interactive exploration without running a full conversion.

## What is intentionally NOT converted

- **Workflows / Flow Designer** — too tightly coupled to ServiceNow's state engine. Out of scope.
- **UI Builder pages / UX experiences** — only legacy UI Pages are surfaced.
- **Record-level ACLs with script conditions** — they show up in `SecurityConfig.java` with `TODO(sn-convert)` markers; port each as a custom `AuthorizationManager`.
- **Reference fields as `@ManyToOne`** — entities use `String` (foreign sys_id) by default. Promote intra-scope references manually.

## JetBrains note

`vscode.lm` is VS Code-only; JetBrains has no equivalent API for Copilot. The conversion pipeline therefore runs in VS Code. You can open the generated Maven project in IntelliJ afterwards — that part is unaffected.
