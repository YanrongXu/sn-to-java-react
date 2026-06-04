import * as path from 'path';
import { GeneratedFile } from '../pipeline/types';

/**
 * For every generated Java class in api/domain/service/web, emit a
 * JUnit 5 test stub in the same module's src/test/java tree. Stubs
 * compile and pass — they're a checklist for the dev, not real tests.
 *
 * Pure template; no LLM. The point is to bake the test-class discipline
 * into the output so nobody forgets to write tests for ported logic.
 */
export function buildJUnitStubs(javaFiles: GeneratedFile[]): GeneratedFile[] {
  const stubs: GeneratedFile[] = [];
  for (const f of javaFiles) {
    if (f.language !== 'java') continue;
    const meta = parseJavaMeta(f);
    if (!meta) continue;
    const stubPath = toTestPath(f.path);
    if (!stubPath) continue;

    const kind = classifyClass(meta.className);
    const stub = renderStub(meta.packageName, meta.className, kind);
    stubs.push({
      path: stubPath,
      content: stub,
      language: 'java',
      origin: f.origin,
      llmInvolved: false,
      structural: true
    });
  }
  return stubs;
}

interface JavaMeta { packageName: string; className: string; }

function parseJavaMeta(f: GeneratedFile): JavaMeta | undefined {
  const pkgMatch = f.content.match(/^package\s+([\w.]+);/m);
  if (!pkgMatch) return undefined;
  const className = path.basename(f.path).replace(/\.java$/, '');
  return { packageName: pkgMatch[1], className };
}

function toTestPath(srcPath: string): string | undefined {
  // .../<mod>/src/main/java/... -> .../<mod>/src/test/java/.../<Cls>Test.java
  const i = srcPath.indexOf('/src/main/java/');
  if (i < 0) return undefined;
  const head = srcPath.slice(0, i);
  const rest = srcPath.slice(i + '/src/main/java/'.length);
  const dir = path.dirname(rest);
  const base = path.basename(rest).replace(/\.java$/, '');
  return `${head}/src/test/java/${dir}/${base}Test.java`;
}

type StubKind = 'entity' | 'repository' | 'service' | 'controller' | 'utility' | 'config' | 'other';
function classifyClass(name: string): StubKind {
  if (name.endsWith('Repository')) return 'repository';
  if (name.endsWith('Controller')) return 'controller';
  if (name.endsWith('Service'))    return 'service';
  if (name.endsWith('Config'))     return 'config';
  if (name.endsWith('Util') || name.endsWith('Utils')) return 'utility';
  if (name.endsWith('Dto'))        return 'other';
  return 'entity';
}

function renderStub(pkg: string, cls: string, kind: StubKind): string {
  switch (kind) {
    case 'entity':
      return `package ${pkg};

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ${cls}Test {

    @Test
    void canConstruct() {
        ${cls} subject = new ${cls}();
        assertNotNull(subject);
        // TODO(sn-convert): exercise getters/setters and equality
    }
}
`;
    case 'repository':
      return `package ${pkg};

import org.junit.jupiter.api.Test;

class ${cls}Test {

    @Test
    void contractStub() {
        // TODO(sn-convert): use @DataJpaTest + @Autowired ${cls} to verify queries
    }
}
`;
    case 'service':
      return `package ${pkg};

import org.junit.jupiter.api.Test;

class ${cls}Test {

    @Test
    void invocationStub() {
        // TODO(sn-convert): instantiate ${cls} with mocked repositories and assert behavior
        //   for each method translated from the original ServiceNow Business Rule
    }
}
`;
    case 'controller':
      return `package ${pkg};

import org.junit.jupiter.api.Test;

class ${cls}Test {

    @Test
    void endpointStub() {
        // TODO(sn-convert): use @WebMvcTest(${cls}.class) and MockMvc to assert routes
    }
}
`;
    case 'utility':
      return `package ${pkg};

import org.junit.jupiter.api.Test;

class ${cls}Test {

    @Test
    void methodsStub() {
        // TODO(sn-convert): cover each ported Script-Include method
    }
}
`;
    case 'config':
      return `package ${pkg};

import org.junit.jupiter.api.Test;

class ${cls}Test {

    @Test
    void wiringStub() {
        // TODO(sn-convert): @SpringBootTest with @AutoConfigureMockMvc to verify SecurityFilterChain rules
    }
}
`;
    default:
      return `package ${pkg};

import org.junit.jupiter.api.Test;

class ${cls}Test {

    @Test
    void smoke() {
        // TODO(sn-convert): add coverage for ${cls}
    }
}
`;
  }
}
