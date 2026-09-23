// Package local contains app-api-only in-process ports between domains.
package local

import (
	"context"

	"contract"
	businessdto "service/business/dto"
	"service/delivery"
	deliverydto "service/delivery/dto"
)

// BusinessProgramReader converts delivery's full project view into the narrow
// project context consumed by the business-intake service.
type BusinessProgramReader struct{ Service delivery.Service }

func (reader BusinessProgramReader) ListProgramContexts(ctx context.Context, bizLine contract.BizLine) ([]businessdto.ProgramContext, error) {
	programs, err := reader.Service.ListPrograms(ctx, bizLine)
	if err != nil {
		return nil, err
	}
	contexts := make([]businessdto.ProgramContext, 0, len(programs))
	for _, program := range programs {
		if program.Status != "active" {
			continue
		}
		contexts = append(contexts, toBusinessProgramContext(program))
	}
	return contexts, nil
}

func (reader BusinessProgramReader) ResolveProgramBizLine(ctx context.Context, programID int64) (contract.BizLine, error) {
	return reader.Service.ResolveProgramBizLine(ctx, programID)
}

func (reader BusinessProgramReader) GetProgramContext(ctx context.Context, bizLine contract.BizLine, programID int64) (businessdto.ProgramContext, error) {
	program, err := reader.Service.GetProgram(ctx, bizLine, programID)
	if err != nil {
		return businessdto.ProgramContext{}, err
	}
	return toBusinessProgramContext(program), nil
}

func toBusinessProgramContext(program deliverydto.ProgramView) businessdto.ProgramContext {
	return businessdto.ProgramContext{
		ProgramID: program.ProgramID, BizLine: program.BizLine.String(), ProgramCode: program.ProgramCode,
		Name: program.Name, Summary: program.Summary,
	}
}
