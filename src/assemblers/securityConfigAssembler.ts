import * as path from 'path';
import { GeneratedFile } from '../pipeline/types';
import { SnAcl } from '../servicenow/types';
import { pluralize, stripPrefix, toCamel } from '../util/naming';

/**
 * Aggregates ServiceNow ACLs into a single Spring SecurityFilterChain bean.
 * Each ACL contributes one authorization rule keyed off the same REST path
 * the CRUD controller exposes. Role names are upper-cased.
 *
 * Caveats logged inline as // TODO(sn-convert): record-level ACLs and
 * script-based ACL conditions need manual review — they can't be expressed
 * declaratively in HttpSecurity.
 */
export function buildSecurityConfig(acls: SnAcl[], basePackage: string, outRoot: string): GeneratedFile {
  const rules: string[] = [];
  for (const acl of acls) {
    const method = acl.operation === 'read'  ? 'GET'
                 : acl.operation === 'create'? 'POST'
                 : acl.operation === 'write' ? 'PUT'
                 : acl.operation === 'delete'? 'DELETE'
                 : 'GET';
    const tableName = acl.table || acl.name.split('.')[0];
    const route = `/api/${pluralize(toCamel(stripPrefix(tableName)))}/**`;
    const rolesExpr = acl.roles.length
      ? `.hasAnyRole(${acl.roles.map(r => `"${r.toUpperCase()}"`).join(', ')})`
      : `.authenticated()`;
    const scriptNote = acl.script ? '    // TODO(sn-convert): original ACL had a script condition — port as a custom AuthorizationManager.' : '';
    rules.push(
      `${scriptNote}\n                .requestMatchers(HttpMethod.${method}, "${route}")${rolesExpr}`
    );
  }

  const body = rules.length
    ? rules.join('\n')
    : '                .anyRequest().authenticated()';

  const content = `package ${basePackage}.web.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Aggregated from ${acls.length} ServiceNow ACL${acls.length === 1 ? '' : 's'}.
 * Review TODO(sn-convert) markers for ACLs with script conditions —
 * those need a custom AuthorizationManager and cannot be expressed
 * fully via HttpSecurity DSL.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable()) // TODO(sn-convert): enable CSRF when frontend acquires tokens
            .authorizeHttpRequests(auth -> auth
${body}
                .anyRequest().authenticated()
            )
            .httpBasic(b -> {});
        return http.build();
    }
}
`;
  return {
    path: path.join(outRoot, 'backend/web/src/main/java', basePackage.replace(/\./g, '/'), 'web/config/SecurityConfig.java'),
    content,
    language: 'java',
    structural: true,
    llmInvolved: false
  };
}
