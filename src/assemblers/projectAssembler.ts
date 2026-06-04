import * as path from 'path';
import * as vscode from 'vscode';
import { GeneratedFile } from '../pipeline/types';
import { SnApplication } from '../servicenow/types';
import { sanitizeArtifactId } from '../util/naming';

/**
 * Builds the *structural* skeleton of the project: parent + module POMs,
 * application.yml (database-agnostic, env-driven), Spring main class,
 * Vite/React project files. These don't depend on any LLM call.
 *
 * Database is intentionally not pinned. The generated POM declares
 * spring-boot-starter-jdbc as a runtime dep but does NOT include any
 * specific JDBC driver — the operator supplies one on the classpath
 * or via `mvn -Dspring-boot.run.jvmArguments=...`. application.yml
 * reads ${DATASOURCE_URL}, ${DB_USER}, ${DB_PASSWORD} from the env.
 */
export function buildStructuralFiles(app: SnApplication, basePackage: string, outRoot: string): GeneratedFile[] {
  const cfg = vscode.workspace.getConfiguration('snConvert');
  const jdk = cfg.get<string>('jdkVersion') ?? '21';
  const sb  = cfg.get<string>('springBootVersion') ?? '3.3.4';
  const wantCs = cfg.get<boolean>('runCheckstyle') ?? false;
  const wantSb = cfg.get<boolean>('runSpotbugs') ?? false;
  const artifactBase = sanitizeArtifactId(app.scope);
  const files: GeneratedFile[] = [];
  const backendRoot = path.join(outRoot, 'backend');

  // Parent POM
  files.push({
    path: path.join(backendRoot, 'pom.xml'),
    content: parentPom(basePackage, artifactBase, app, jdk, sb, wantCs, wantSb),
    language: 'xml',
    structural: true,
    llmInvolved: false
  });

  // Module POMs
  for (const mod of ['api', 'domain', 'service', 'web'] as const) {
    files.push({
      path: path.join(backendRoot, mod, 'pom.xml'),
      content: modulePom(basePackage, artifactBase, mod),
      language: 'xml',
      structural: true,
      llmInvolved: false
    });
  }

  // application.yml
  files.push({
    path: path.join(backendRoot, 'web/src/main/resources/application.yml'),
    content: applicationYml(app),
    language: 'yaml',
    structural: true,
    llmInvolved: false
  });

  // Main class
  files.push({
    path: path.join(backendRoot, 'web/src/main/java', basePackage.replace(/\./g, '/'), 'web/Application.java'),
    content: mainClass(basePackage),
    language: 'java',
    structural: true,
    llmInvolved: false
  });

  // React project structural files
  const frontendRoot = path.join(outRoot, 'frontend');
  files.push(
    { path: path.join(frontendRoot, 'package.json'),    content: frontendPackageJson(app),  language: 'json', structural: true, llmInvolved: false },
    { path: path.join(frontendRoot, 'tsconfig.json'),   content: frontendTsConfig(),        language: 'json', structural: true, llmInvolved: false },
    { path: path.join(frontendRoot, 'vite.config.ts'),  content: viteConfig(),              language: 'ts',   structural: true, llmInvolved: false },
    { path: path.join(frontendRoot, 'index.html'),      content: indexHtml(app),            language: 'html', structural: true, llmInvolved: false },
    { path: path.join(frontendRoot, 'src/main.tsx'),    content: mainTsx(),                 language: 'tsx',  structural: true, llmInvolved: false },
    { path: path.join(frontendRoot, 'src/api/client.ts'),content: apiClient(),              language: 'ts',   structural: true, llmInvolved: false }
  );
  return files;
}

// ---------------- POM helpers ----------------

function parentPom(basePackage: string, artifactBase: string, app: SnApplication, jdk: string, sb: string, wantCs: boolean, wantSb: boolean): string {
  const csPlugin = wantCs ? `
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-checkstyle-plugin</artifactId>
        <version>3.3.1</version>
      </plugin>` : '';
  const sbPlugin = wantSb ? `
      <plugin>
        <groupId>com.github.spotbugs</groupId>
        <artifactId>spotbugs-maven-plugin</artifactId>
        <version>4.8.6.4</version>
      </plugin>` : '';
  const pluginsXml = (csPlugin || sbPlugin)
    ? `\n  <build><plugins>${csPlugin}${sbPlugin}\n    </plugins></build>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>

  <groupId>${basePackage}</groupId>
  <artifactId>${artifactBase}-parent</artifactId>
  <version>0.1.0-SNAPSHOT</version>
  <packaging>pom</packaging>
  <name>${app.name} (converted)</name>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>${sb}</version>
    <relativePath/>
  </parent>

  <properties>
    <java.version>${jdk}</java.version>
    <maven.compiler.release>${jdk}</maven.compiler.release>
  </properties>

  <modules>
    <module>api</module>
    <module>domain</module>
    <module>service</module>
    <module>web</module>
  </modules>

  <dependencyManagement>
    <dependencies>
      <dependency><groupId>${basePackage}</groupId><artifactId>${artifactBase}-api</artifactId><version>\${project.version}</version></dependency>
      <dependency><groupId>${basePackage}</groupId><artifactId>${artifactBase}-domain</artifactId><version>\${project.version}</version></dependency>
      <dependency><groupId>${basePackage}</groupId><artifactId>${artifactBase}-service</artifactId><version>\${project.version}</version></dependency>
    </dependencies>
  </dependencyManagement>${pluginsXml}
</project>
`;
}

function modulePom(basePackage: string, artifactBase: string, mod: 'api' | 'domain' | 'service' | 'web'): string {
  const deps: string[] = [];
  if (mod === 'domain') {
    deps.push('<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>');
    deps.push('<dependency><groupId>org.liquibase</groupId><artifactId>liquibase-core</artifactId></dependency>');
  }
  if (mod === 'service') {
    deps.push(`<dependency><groupId>${basePackage}</groupId><artifactId>${artifactBase}-domain</artifactId></dependency>`);
  }
  if (mod === 'web') {
    deps.push('<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>');
    deps.push('<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>');
    deps.push('<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>');
    deps.push(`<dependency><groupId>${basePackage}</groupId><artifactId>${artifactBase}-service</artifactId></dependency>`);
    deps.push(`<dependency><groupId>${basePackage}</groupId><artifactId>${artifactBase}-api</artifactId></dependency>`);
  }
  deps.push('<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>');

  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>${basePackage}</groupId>
    <artifactId>${artifactBase}-parent</artifactId>
    <version>0.1.0-SNAPSHOT</version>
  </parent>
  <artifactId>${artifactBase}-${mod}</artifactId>

  <dependencies>
    ${deps.join('\n    ')}
  </dependencies>
</project>
`;
}

function applicationYml(app: SnApplication): string {
  // Database-agnostic. Driver and dialect resolved at runtime from JDBC URL.
  return `spring:
  application:
    name: ${app.scope}
  datasource:
    url: \${DATASOURCE_URL}
    username: \${DB_USER}
    password: \${DB_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: validate
    properties:
      hibernate.format_sql: true
  liquibase:
    change-log: classpath:db/changelog/db.changelog-master.xml

server:
  port: 8080
`;
}

function mainClass(basePackage: string): string {
  return `package ${basePackage}.web;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@SpringBootApplication(scanBasePackages = "${basePackage}")
@EntityScan(basePackages = "${basePackage}.domain")
@EnableJpaRepositories(basePackages = "${basePackage}.domain")
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`;
}

// ---------------- React structural ----------------

function frontendPackageJson(app: SnApplication): string {
  return JSON.stringify({
    name: `${app.scope}-frontend`,
    private: true, version: '0.1.0', type: 'module',
    scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-router-dom': '^6.26.0', '@tanstack/react-query': '^5.51.0' },
    devDependencies: { '@types/react': '^18.3.3', '@types/react-dom': '^18.3.0', '@vitejs/plugin-react': '^4.3.1', typescript: '^5.5.0', vite: '^5.4.0' }
  }, null, 2);
}
function frontendTsConfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022","DOM","DOM.Iterable"], "module": "ESNext",
    "moduleResolution": "bundler", "jsx": "react-jsx", "strict": true,
    "skipLibCheck": true, "isolatedModules": true, "noEmit": true,
    "resolveJsonModule": true, "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
`;
}
function viteConfig(): string {
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080' } }
});
`;
}
function indexHtml(app: SnApplication): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"/><title>${app.name}</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
`;
}
function mainTsx(): string {
  return `import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div style={{ padding: '1rem', fontFamily: 'system-ui' }}>
          {/* TODO(sn-convert): import generated pages and wire <Routes> */}
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
`;
}
function apiClient(): string {
  return `const BASE = '/api';
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(\`\${method} \${path} -> \${res.status}\`);
  if (res.status === 204) return undefined as T;
  return res.json();
}
`;
}
