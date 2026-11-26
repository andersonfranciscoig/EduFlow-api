import { periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import type { PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import { gradeName } from "./GradingModels";

/**
 * As classificações do aluno para a família: só o que a direção publicou (a última publicação de
 * cada disciplina e período: depois de uma retificação, a corrigida). Nunca o que está em curso.
 * Quem pode ver o aluno confirma-o quem chama (o encarregado que o gere, ou o próprio aluno maior).
 */
export async function familyGrades(books: PrismaGradebookRepository, studentId: string, groupId: string) {
  const g = await books.groupHeader(groupId);
  if (!g) return null;
  const kind = g.periodKind as PeriodKind;
  const [periods, subjects, published] = await Promise.all([books.periods(g.yearId), books.groupSubjects(groupId), books.studentPublications(g.yearId, studentId)]);
  return {
    year: { id: g.yearId, name: g.yearName },
    group: { name: g.groupName, classLabel: gradeName(g.grade, g.courseName) },
    periods: periods.map((p) => ({ position: p.position, name: periodName(kind, p.position) })),
    subjects: subjects.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      color: s.color,
      periods: Object.fromEntries(
        published
          .filter((p) => p.subjectId === s.id)
          .map((p) => [
            p.period,
            {
              status: p.result.status,
              value: p.result.value,
              level: p.result.level,
              passed: p.result.passed,
              comment: p.result.comment,
              publishedAt: p.publishedAt.toISOString(),
              rectified: p.number > 1,
              reason: p.number > 1 ? p.reason : null,
            },
          ]),
      ),
    })),
    published: published.length,
  };
}
