# ServiceNow JS → Spring/Java mapping guide

## GlideRecord

| ServiceNow | Java / Spring |
| --- | --- |
| `new GlideRecord('x_acme_orders_order')` | `OrderRepository.findAll(...)` or `EntityManager.createQuery(...)` |
| `gr.addQuery('field', value)` | Spring Data derived method: `findByFieldEquals(value)`, or a JPA `WHERE` clause |
| `gr.addQuery('field', '!=', value)` | `findByFieldNot(value)` or JPQL `field <> :value` |
| `gr.addQuery('field', 'IN', list)` | `findByFieldIn(Collection)` |
| `gr.orderBy('field')` | `Sort.by("field").ascending()` |
| `gr.setLimit(n)` | `PageRequest.of(0, n)` |
| `gr.query()` then `gr.next()` | `for (Entity e : repository.findAll(...))` |
| `gr.get(sysId)` | `repository.findById(sysId).orElse(null)` |
| `gr.insert()` | `repository.save(newEntity)` |
| `gr.update()` | `repository.save(existing)` |
| `gr.deleteRecord()` | `repository.delete(entity)` |
| `gr.getValue('x')` | `entity.getX()` |
| `gr.setValue('x', v)` | `entity.setX(v)` |
| `gr.getDisplayValue('x')` | For references: `entity.getX().getName()` (or similar) — **add TODO(sn-convert)** since display values are not standardized in JPA |

## GlideAggregate

| ServiceNow | Java |
| --- | --- |
| `new GlideAggregate('table')` + `addAggregate('COUNT')` | JPQL `SELECT COUNT(e) FROM Entity e WHERE …` |
| `addAggregate('SUM','field')` | JPQL `SELECT SUM(e.field) FROM …` |
| `groupBy('field')` | JPQL `GROUP BY e.field` |

## GlideSystem (gs.*)

| ServiceNow | Java |
| --- | --- |
| `gs.getUserID()` | `SecurityContextHolder.getContext().getAuthentication().getName()` (or your custom resolver) |
| `gs.hasRole('admin')` | `request.isUserInRole("ADMIN")` or `@PreAuthorize("hasRole('ADMIN')")` |
| `gs.info(msg)` / `gs.warn(msg)` / `gs.error(msg)` | `log.info(msg)`, `log.warn(msg)`, `log.error(msg)` (SLF4J) |
| `gs.nowDateTime()` | `LocalDateTime.now()` |
| `gs.eventQueue(...)` | `ApplicationEventPublisher.publishEvent(...)` — **add TODO(sn-convert)** to confirm event semantics |
| `gs.executeNow(scheduled)` | `@Scheduled` or `TaskScheduler.schedule(...)` — **add TODO(sn-convert)** |

## Action timing

| When | Spring equivalent |
| --- | --- |
| `before` insert/update | A method called by the service before `repository.save()`, OR a JPA `@PrePersist` / `@PreUpdate` callback on the entity |
| `after` insert/update | `@PostPersist` / `@PostUpdate` callback, OR `ApplicationEventPublisher` event |
| `async` | `@Async` method (requires `@EnableAsync`) |
| `display` | Not applicable on the server; this is typically a form-prep step. Convert to a DTO assembler or projection. **Add TODO(sn-convert).** |

## Common idioms

- `current.setAbortAction(true)` → throw a custom `BusinessRuleAbortException` that the caller maps to HTTP 409.
- `current.operation()` checks — collapse into the timing-specific method name; don't preserve the runtime check.
- `JSON.parse(input)` → Jackson `ObjectMapper.readValue(input, Map.class)` (inject ObjectMapper).
- `g_request.getHeader('X-Foo')` (in scripted REST) → `@RequestHeader("X-Foo") String foo`.

## When in doubt

If you can't confidently convert a fragment, emit:

```java
// TODO(sn-convert): <one-line description of what's ambiguous>
```

…and leave a working stub (return null, return empty list, etc.) so the file still compiles.
